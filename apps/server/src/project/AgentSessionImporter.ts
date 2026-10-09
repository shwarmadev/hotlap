import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import {
  MAX_IMPORTED_THREAD_AUDIT_EVENTS,
  importedBindingMatches,
  canReconcileImportedHistory,
  isImportedHistoryEvent,
} from "./ImportedHistorySafety.ts";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeLegacyImportMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ historyImport: Schema.Boolean })),
);
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

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
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    let repairedCount = 0;
    let archivedCount = 0;
    const sessionKey = (source: AgentSessionImportSource) =>
      `${source.providerInstanceId}\0${source.providerSessionId}`;
    const currentReview = (source: AgentSessionImportSource) =>
      source.parserVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION ||
      source.parserReviewVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION;
    const staleKeys = new Set(
      Array.from(Map.groupBy(completedSources, sessionKey)).flatMap(([key, sources]) =>
        sources.some(currentReview) ? [] : [key],
      ),
    );
    const reconciledKeys = new Set<string>();
    const preserve = (threadId: ThreadId, source: AgentSessionImportSource) => {
      const { parserVersion: _parserVersion, ...identity } = source;
      return runtimes.recordImportedTranscript({
        threadId,
        source: {
          ...identity,
          parserReviewVersion: AgentSessionScanner.AGENT_SESSION_PARSER_VERSION,
        },
      });
    };
    yield* Stream.runForEach(
      scanner.reconcileCandidates(project.workspaceRoot, completedSources),
      (candidate) =>
        runtimes
          .withWriteTransaction(
            Effect.gen(function* () {
              const threadId = ThreadId.make(
                `import:${candidate.source.providerInstanceId}:${candidate.source.providerSessionId}`,
              );
              const projection = yield* orchestrator.getThreadProjection(threadId);
              if (
                projection.thread.projectId !== input.projectId ||
                projection.thread.historyOrigin !== "v1_import" ||
                projection.thread.deletedAt !== null
              )
                return;
              if (candidate._tag === "PreserveImported")
                return yield* preserve(threadId, candidate.source);
              const runtime = yield* runtimes.getByThreadId({ threadId });
              if (
                Option.isNone(runtime) ||
                !importedBindingMatches(runtime.value, candidate.source, threadId) ||
                !canReconcileImportedHistory(projection)
              ) {
                if (Option.isSome(runtime)) yield* preserve(threadId, candidate.source);
                return;
              }
              const events = Array.from(
                yield* eventStore
                  .read({ threadId, limit: MAX_IMPORTED_THREAD_AUDIT_EVENTS + 1 })
                  .pipe(Stream.runCollect),
              );
              if (
                events.length === 0 ||
                events.length > MAX_IMPORTED_THREAD_AUDIT_EVENTS ||
                !events.every(isImportedHistoryEvent)
              )
                return yield* preserve(threadId, candidate.source);
              // V1's migration events describe its final state; audit the original commands too.
              if (events.some((stored) => stored.event.id.startsWith("migration:v1:"))) {
                const legacy = yield* sql<{
                  readonly event_type: string;
                  readonly metadata_json: string;
                }>`SELECT event_type, metadata_json FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND application_event_version = 1 ORDER BY sequence LIMIT ${MAX_IMPORTED_THREAD_AUDIT_EVENTS + 1}`;
                if (
                  legacy.length === 0 ||
                  legacy.length > MAX_IMPORTED_THREAD_AUDIT_EVENTS ||
                  !legacy.every((row) => {
                    const metadata = decodeLegacyImportMetadata(row.metadata_json);
                    return (
                      Option.isSome(metadata) &&
                      metadata.value.historyImport === true &&
                      ["thread.created", "thread.message-sent", "thread.settled"].includes(
                        row.event_type,
                      )
                    );
                  })
                )
                  return yield* preserve(threadId, candidate.source);
              }
              const at = yield* DateTime.now;
              const replacing = candidate._tag === "ReplaceImported";
              const replacement = replacing
                ? candidate.thread.messages.flatMap((message, index) =>
                    messageEvents({ threadId, index, message }),
                  )
                : [];
              const thread: OrchestrationV2AppThread = replacing
                ? {
                    ...projection.thread,
                    title: candidate.thread.title,
                    modelSelection: {
                      instanceId: candidate.thread.providerInstanceId,
                      model:
                        candidate.thread.model ??
                        DEFAULT_MODEL_BY_PROVIDER[
                          ProviderDriverKind.make(candidate.thread.source)
                        ] ??
                        DEFAULT_MODEL,
                    },
                    createdAt: dateTime(candidate.thread.createdAt),
                    updatedAt: dateTime(candidate.thread.updatedAt),
                    settledAt: dateTime(candidate.thread.updatedAt),
                  }
                : { ...projection.thread, archivedAt: at, updatedAt: at };
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make(
                      `${IMPORT_EVENT_PREFIX}:reconcile:${yield* idAllocator.allocate.event({ threadId })}`,
                    ),
                    type: "thread.imported-history-reconciled",
                    threadId,
                    occurredAt: at,
                    payload: {
                      thread,
                      messages: replacing
                        ? replacement.flatMap((event) =>
                            event.type === "message.updated" ? [event.payload] : [],
                          )
                        : projection.messages,
                      turnItems: replacing
                        ? replacement.flatMap((event) =>
                            event.type === "turn-item.updated" ? [event.payload] : [],
                          )
                        : projection.turnItems,
                    },
                  },
                ],
              });
              yield* runtimes.recordImportedTranscript({ threadId, source: candidate.source });
              return replacing ? ("repaired" as const) : ("archived" as const);
            }),
          )
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result === undefined) return;
                reconciledKeys.add(sessionKey(candidate.source));
                if (result === "repaired") repairedCount += 1;
                else archivedCount += 1;
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Could not reconcile an imported agent session", {
                source: candidate.source.providerSessionId,
                cause,
              }),
            ),
          ),
    );

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (staleKeys.has(sessionKey(source)) && !reconciledKeys.has(sessionKey(source)))
            return yield* new AgentSessionThreadModifiedError({ threadId });
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (
              existing.value.thread.historyOrigin !== "v1_import" ||
              existing.value.thread.deletedAt !== null
            ) {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const driver = ProviderDriverKind.make(thread.source);
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: thread.providerSessionId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: thread.providerSessionId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          yield* runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          runtimes.withWriteTransaction,
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
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

  return { importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
