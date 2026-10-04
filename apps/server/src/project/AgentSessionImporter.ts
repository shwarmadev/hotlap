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
  type OrchestrationEvent,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
<<<<<<< HEAD
  type OrchestrationThread,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
=======
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
<<<<<<< HEAD
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
=======
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7

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

<<<<<<< HEAD
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
=======
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
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7
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
<<<<<<< HEAD
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
=======
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
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

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
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

<<<<<<< HEAD
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
=======
          const driver = ProviderDriverKind.make(thread.source);
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: thread.providerSessionId,
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7
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

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

<<<<<<< HEAD
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
=======
  return { importRecentAgentThreads };
>>>>>>> 737993303d36e10674c54b95e5bd3826682c99c7
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
