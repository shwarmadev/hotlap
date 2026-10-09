import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  ProviderSessionId,
  ProviderDriverKind,
  type HotlapGuardedSessionStop,
  EnvironmentHttpApi,
  type ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentTranscriptTooLarge,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ReadableTranscriptService from "./ReadableTranscriptService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { buildActiveShellSnapshot, loadShellSnapshotParts } from "./ShellStream.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

export const getReadableThreadTranscript = Effect.fn("environment.orchestration.threadTranscript")(
  function* (threadId: ThreadId) {
    yield* requireEnvironmentScope(AuthOrchestrationReadScope);
    const service = yield* ReadableTranscriptService.ReadableTranscriptService;
    return yield* service.get(threadId).pipe(
      Effect.catchTags({
        ReadableTranscriptNotFoundError: () => failEnvironmentNotFound("thread_not_found"),
        ReadableTranscriptTooLargeError: () => failEnvironmentTranscriptTooLarge(),
        ReadableTranscriptLoadError: (cause) =>
          failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
      }),
    );
  },
);

export const stopIdleCodexSession = Effect.fn("environment.orchestration.dispatch")(function* (
  command: HotlapGuardedSessionStop,
) {
  yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const result = yield* threadManagement
    .dispatch({
      type: "provider-session.detach",
      commandId: command.commandId,
      threadId: command.threadId,
      providerSessionId: ProviderSessionId.make(command.expectedProviderSessionId),
      idleGuard: {
        snapshotSequence: command.snapshotSequence,
        expectedProviderName: ProviderDriverKind.make(command.expectedProviderName),
      },
    })
    .pipe(Effect.catch(() => failEnvironmentInvalidRequest("guarded_session_stop_rejected")));
  return { sequence: result.sequence };
});

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = buildActiveShellSnapshot(
        yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "active" }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      const threads = yield* Effect.forEach(
        base.threads,
        (thread) =>
          Effect.gen(function* () {
            const snapshot = yield* threadManagement.getThreadRecords(thread.id, [
              "providerSessions",
            ]);
            let session = null;
            let backgroundLiveness: "working" | null =
              (thread.pendingBackgroundTasks?.length ?? 0) > 0 ? "working" : null;
            for (const candidate of snapshot.providerSessions.toSorted(
              (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
            )) {
              const runtime = yield* providerSessions.get(candidate.id);
              if (Option.isNone(runtime)) continue;
              if (
                runtime.value.hasPendingBackgroundWork !== undefined &&
                (yield* runtime.value.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(true)),
                ))
              )
                backgroundLiveness = "working";
              session = {
                providerName: candidate.driver,
                providerSessionId: candidate.id,
                providerInstanceId: candidate.providerInstanceId,
                status: thread.activeRunId !== null ? ("running" as const) : ("ready" as const),
                activeTurnId: thread.activeRunId,
              };
              break;
            }
            const latestTurn =
              thread.latestRunId === null
                ? null
                : {
                    state:
                      thread.activeRunId !== null
                        ? ("running" as const)
                        : thread.status === "failed"
                          ? ("error" as const)
                          : ("completed" as const),
                    requestedAt: DateTime.formatIso(
                      thread.latestRunRequestedAt ?? thread.updatedAt,
                    ),
                    startedAt:
                      thread.latestRunStartedAt == null
                        ? null
                        : DateTime.formatIso(thread.latestRunStartedAt),
                    completedAt:
                      thread.latestRunCompletedAt == null
                        ? null
                        : DateTime.formatIso(thread.latestRunCompletedAt),
                  };
            return {
              ...thread,
              session,
              latestTurn,
              hasPendingApprovals:
                thread.pendingRuntimeRequest !== null &&
                thread.pendingRuntimeRequest.kind !== "user_input",
              hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
              backgroundLiveness,
            };
          }),
        { concurrency: 16 },
      );
      return { ...base, projects, threads };
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return handlers
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* getReadableThreadTranscript(args.params.threadId);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* stopIdleCodexSession(args.payload);
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(traceLocalHandlerWork);
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshotWindow(args.params.threadId).pipe(
            traceLocalHandlerWork,
          );
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            ...boundedSnapshotResponseFields({
              bounded,
              compactTurnItems: args.query.compactTurnItems === "1",
            }),
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          try {
            decodeThreadHistoryCursor(args.query.cursor);
          } catch (cause) {
            if (cause instanceof InvalidThreadHistoryCursorError)
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          return yield* threadManagement
            .getThreadHistoryPage(
              args.params.threadId,
              args.query.cursor,
              args.query.throughEntryId,
              args.query.view === "conversation",
            )
            .pipe(
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_history_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      );
  }),
);
