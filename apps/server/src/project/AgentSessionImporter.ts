import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationThread,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMPORTED_THREAD_AUDIT_EVENTS = 1_000;

const ImportedResumeCursor = Schema.Struct({
  threadId: Schema.String,
  resume: Schema.optional(Schema.String),
});
const decodeImportedResumeCursor = Schema.decodeUnknownOption(ImportedResumeCursor);

function bindingMatchesImportedSource(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
  source: AgentSessionScanner.AgentSessionReconcileCandidate["source"],
  threadId: ThreadId,
): boolean {
  if (
    binding.threadId !== threadId ||
    binding.provider !== source.provider ||
    binding.providerInstanceId !== source.providerInstanceId ||
    binding.status !== "stopped"
  ) {
    return false;
  }
  const cursor = decodeImportedResumeCursor(binding.resumeCursor);
  if (Option.isNone(cursor)) return false;
  return source.provider === "codex"
    ? cursor.value.threadId === source.providerSessionId
    : cursor.value.threadId === threadId && cursor.value.resume === source.providerSessionId;
}

function isImportedHistoryEvent(event: OrchestrationEvent): boolean {
  return (
    event.metadata.historyImport === true &&
    (event.type === "thread.created" ||
      event.type === "thread.message-sent" ||
      event.type === "thread.settled")
  );
}

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function importedSessionKey(source: AgentSessionImportSource): string {
  return `${source.providerInstanceId}\0${source.providerSessionId}`;
}

function parserReviewedSource(source: AgentSessionImportSource): AgentSessionImportSource {
  const { parserVersion: _parserVersion, ...identity } = source;
  return {
    ...identity,
    parserReviewVersion: AgentSessionScanner.AGENT_SESSION_PARSER_VERSION,
  };
}

function hasCurrentParserReview(source: AgentSessionImportSource): boolean {
  return (
    source.parserVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION ||
    source.parserReviewVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION
  );
}

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.autoSettleDisabledAt != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;
  let repairedCount = 0;
  let archivedCount = 0;
  const completedSourcesBySession = Map.groupBy(
    completedSources.map((entry) => entry.source),
    importedSessionKey,
  );
  const staleSessionKeys = new Set(
    Array.from(completedSourcesBySession.entries()).flatMap(([sessionKey, sources]) =>
      sources.some(hasCurrentParserReview) ? [] : [sessionKey],
    ),
  );
  const reconciledSessionKeys = new Set<string>();

  const preserveModifiedImport = Effect.fn("AgentSessionImporter.preserveModifiedImport")(
    function* (threadId: ThreadId, source: AgentSessionImportSource) {
      yield* directory.recordImportedTranscript({
        threadId,
        source: parserReviewedSource(source),
      });
    },
  );

  yield* Stream.runForEach(
    scanner.reconcileCandidates(
      workspaceRoot,
      completedSources.map((entry) => entry.source),
    ),
    (candidate) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(
          `import:${candidate.source.providerInstanceId}:${candidate.source.providerSessionId}`,
        );
        const sessionKey = importedSessionKey(candidate.source);
        const reconciled = yield* Effect.gen(function* () {
          const existingThread = yield* snapshots.getThreadDetailById(threadId);
          const existingBinding = yield* directory.getBinding(threadId);
          if (
            Option.isNone(existingThread) ||
            existingThread.value.projectId !== input.projectId ||
            !hasImportedHistory(existingThread.value)
          ) {
            return yield* new AgentSessionThreadModifiedError({ threadId });
          }
          if (candidate._tag === "PreserveImported") {
            yield* preserveModifiedImport(threadId, candidate.source);
            return "preserved" as const;
          }
          if (
            Option.isNone(existingBinding) ||
            !bindingMatchesImportedSource(existingBinding.value, candidate.source, threadId)
          ) {
            if (Option.isSome(existingBinding)) {
              yield* preserveModifiedImport(threadId, candidate.source);
            }
            return yield* new AgentSessionThreadModifiedError({ threadId });
          }
          if (hasImportBlockingActivity(existingThread.value, true)) {
            yield* preserveModifiedImport(threadId, candidate.source);
            return yield* new AgentSessionThreadModifiedError({ threadId });
          }

          const snapshotSequence = yield* engine.latestSequence;
          const stats = yield* engine.getThreadReplayStats({
            threadId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: snapshotSequence,
            maxEvents: MAX_IMPORTED_THREAD_AUDIT_EVENTS,
          });
          if (stats.eventCount === 0 || stats.eventCount > MAX_IMPORTED_THREAD_AUDIT_EVENTS) {
            yield* preserveModifiedImport(threadId, candidate.source);
            return yield* new AgentSessionThreadModifiedError({ threadId });
          }
          const audit = yield* engine
            .readThreadEvents({
              threadId,
              fromSequenceExclusive: 0,
              toSequenceInclusive: snapshotSequence,
              limit: MAX_IMPORTED_THREAD_AUDIT_EVENTS + 1,
            })
            .pipe(
              Stream.runFold(
                () => ({ eventCount: 0, allImported: true }),
                (state, event: OrchestrationEvent) => ({
                  eventCount: state.eventCount + 1,
                  allImported: state.allImported && isImportedHistoryEvent(event),
                }),
              ),
            );
          if (audit.eventCount !== stats.eventCount || !audit.allImported) {
            yield* preserveModifiedImport(threadId, candidate.source);
            return yield* new AgentSessionThreadModifiedError({ threadId });
          }

          if (candidate._tag === "ArchiveImported") {
            const archivedAt = DateTime.formatIso(yield* DateTime.now);
            yield* engine.dispatch({
              type: "thread.history.reconcile",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId,
              snapshotSequence,
              action: { type: "archiveExcluded", archivedAt },
            });
            yield* directory.recordImportedTranscript({ threadId, source: candidate.source });
            return "archived" as const;
          }

          const provider = ProviderDriverKind.make(candidate.thread.source);
          const model =
            candidate.thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
          yield* engine.dispatch({
            type: "thread.history.reconcile",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            snapshotSequence,
            action: {
              type: "replaceHistory",
              projectId: input.projectId,
              title: candidate.thread.title,
              modelSelection: { instanceId: candidate.thread.providerInstanceId, model },
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: candidate.thread.createdAt,
              messages: candidate.thread.messages.map((message, index) => ({
                messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
              })),
            },
          });
          yield* directory.recordImportedTranscript({ threadId, source: candidate.source });
          return "repaired" as const;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not reconcile an imported agent session", {
              provider: candidate.source.provider,
              sessionId: candidate.source.providerSessionId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );

        if (reconciled === "repaired") {
          reconciledSessionKeys.add(sessionKey);
          repairedCount += 1;
        } else if (reconciled === "archived") {
          reconciledSessionKeys.add(sessionKey);
          archivedCount += 1;
        }
      }),
  );

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* Effect.gen(function* () {
        const provider = ProviderDriverKind.make(thread.source);
        const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
        const existingThread = yield* snapshots.getThreadDetailById(threadId);
        const existingBinding = yield* directory.getBinding(threadId);

        if (
          staleSessionKeys.has(importedSessionKey(outcome.source)) &&
          !reconciledSessionKeys.has(importedSessionKey(outcome.source))
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        if (
          thread.source === "claudeAgent" &&
          !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
        ) {
          return yield* new AgentSessionUnresumableSessionError({
            source: thread.source,
            providerSessionId: thread.providerSessionId,
          });
        }

        if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
          return yield* new AgentSessionThreadProjectConflictError({
            threadId,
            expectedProjectId: input.projectId,
            actualProjectId: existingThread.value.projectId,
          });
        }

        const importedHistoryPresent = Option.isSome(existingThread)
          ? hasImportedHistory(existingThread.value)
          : false;
        if (
          Option.isSome(existingThread) &&
          importedHistoryPresent &&
          Option.isSome(existingBinding)
        ) {
          yield* directory.recordImportedTranscript({ threadId, source: outcome.source });
          return true;
        }

        if (
          Option.isSome(existingThread) &&
          hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        if (
          Option.isSome(existingBinding) &&
          (existingBinding.value.provider !== provider ||
            existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
            existingBinding.value.status !== "stopped")
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        // Install the cursor before the thread becomes visible. A concurrent
        // real session can replace it, while insert-ignore keeps this import
        // from replacing that newer binding.
        if (Option.isNone(existingBinding)) {
          yield* directory.upsert(
            {
              threadId,
              provider,
              providerInstanceId: thread.providerInstanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: workspaceRoot },
            },
            { onConflict: "ignore" },
          );
        }

        if (Option.isNone(existingThread)) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: input.projectId,
            title: thread.title,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
            historyImport: true,
          });
        }

        if (!importedHistoryPresent) {
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messages: thread.messages.map((message, index) => ({
              messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
            })),
          });
        }

        yield* directory.recordImportedTranscript({ threadId, source: outcome.source });

        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return {
    importedCount,
    skippedCount,
    ...(repairedCount === 0 ? {} : { repairedCount }),
    ...(archivedCount === 0 ? {} : { archivedCount }),
  } satisfies AgentSessionImportResult;
});
