import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { canStopThreadSessionIfIdle } from "../SessionStopPolicy.ts";
import { threadHasQueuedTurnStart } from "../ThreadSettlementPolicy.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  isProviderAccountConfirmedUnusable,
  selectAutomaticProviderAccount,
} from "../../provider/providerAccountRouting.ts";

const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const PROVIDER_ACCOUNT_ROUTING_BLOCKED = Symbol("provider-account-routing-blocked");
const MIN_PROVIDER_USAGE_FRESHNESS = Duration.minutes(10);
const STARTING_SESSION_RECOVERY_TIMEOUT = Duration.seconds(5);
const TERMINAL_TURN_STATES = new Set(["completed", "error", "interrupted"]);

function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const compactingThreadIds = new Set<ThreadId>();
  type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  // Turn starts received while a thread compacts, replayed in order once its session is restored.
  const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
  // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
  // provider send finishes, which is what lets the next queued turn follow it in order.
  const resumedTurnStarts = new Map<
    CommandId,
    {
      readonly event: QueuedTurnStart;
      readonly queued: Array<QueuedTurnStart>;
      readonly sent: Deferred.Deferred<void>;
    }
  >();
  const stoppingThreadIds = new Set<ThreadId>();
  const pendingTurnReconciliations = new Set<ThreadId>();
  const pendingTurnSends = new Set<string>();
  const admittedPendingTurns = new Set<string>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.account.route.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly terminalTurnStart?: true;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
              ...(input.terminalTurnStart === true ? { terminalTurnStart: true } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    turnsAfterCompaction.delete(threadId);
    for (const event of queued) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        requestId: event.payload.messageId,
      }).pipe(Effect.ignore({ log: true, message: "failed to report canceled queued message" }));
    }
  });

  const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
    threadId: ThreadId,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
      const event = queued[0]!;
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId,
        messageId: event.payload.messageId,
      });
      if (turnsAfterCompaction.get(threadId) !== queued) return;
      // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
      queued.shift();
      if (Option.isNone(turnStart)) continue;
      // Reissue the durable request after restoration clears compaction's
      // pending slot. Reusing the message id preserves a single user bubble.
      const commandId = yield* serverCommandId("after-compaction");
      const sent = yield* Deferred.make<void>();
      resumedTurnStarts.set(commandId, { event, queued, sent });
      const { messageId, ...request } = event.payload;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          ...request,
          message: {
            messageId,
            role: "user",
            text: turnStart.value.message.text,
            attachments: turnStart.value.message.attachments ?? [],
          },
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              resumedTurnStarts.delete(commandId);
              queued.unshift(event);
            }),
          ),
        );
      yield* Deferred.await(sent);
      resumedTurnStarts.delete(commandId);
    }
    if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
  });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterProcessError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    if (isProviderWorkspaceMissingError(failReason?.error)) {
      return failReason.error.message;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
    readonly expectedProviderSessionId?: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          ...(input.expectedProviderSessionId !== undefined
            ? { expectedProviderSessionId: input.expectedProviderSessionId }
            : {}),
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerSessionId: undefined,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    // Best effort like the rest of this recovery: a settings read failure
    // falls back to the checkout's t3.json.
    const submodules = yield* projectSettingsForThread(thread.id).pipe(
      Effect.map((settings) => settings.worktreeSubmodules),
      Effect.orElseSucceed(() => null),
    );
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(
        gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath }, { submodules }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("provider command reactor failed to recreate worktree", {
            threadId: thread.id,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly allowIncompatibleUnstartedReplacement?: true;
    },
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const allowIncompatibleUnstartedReplacement =
      options?.allowIncompatibleUnstartedReplacement === true && thread.latestTurn === null;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerSessionId: activeSession?.providerSessionId ?? activeSession?.createdAt,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        !allowIncompatibleUnstartedReplacement &&
        currentInfo.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;

    const startProviderSession = (input?: { readonly resumeCursor?: unknown }) => {
      const startInput = {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(thread.title ? { title: thread.title } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      };
      const start = allowIncompatibleUnstartedReplacement
        ? providerService.startSession(threadId, startInput, {
            allowIncompatibleUnstartedReplacement: true,
          })
        : providerService.startSession(threadId, startInput);
      return start.pipe(Effect.tap(() => refreshWorkspaceSnapshot));
    };

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerSessionId: session.providerSessionId ?? session.createdAt,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return existingSessionThreadId;
      }

      const resumeCursor = allowIncompatibleUnstartedReplacement
        ? undefined
        : shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const maybeRouteProviderAccount = Effect.fn("maybeRouteProviderAccount")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly requestedModelSelection?: ModelSelection;
    readonly messageId: string;
    readonly createdAt: string;
    readonly resumed: boolean;
    readonly allow: boolean;
  }) {
    const currentSelection = input.requestedModelSelection ?? input.thread.modelSelection;
    if (
      input.resumed ||
      !input.allow ||
      input.messageId.startsWith("async-answer:") ||
      input.thread.providerRoutingMode !== "auto" ||
      input.thread.backgroundLiveness != null ||
      input.thread.session?.status === "starting" ||
      input.thread.session?.status === "running" ||
      currentSelection.instanceId !== input.thread.modelSelection.instanceId
    ) {
      return null;
    }
    const activeRuntimeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === input.thread.id,
    );
    if (
      activeRuntimeSession?.status === "connecting" ||
      activeRuntimeSession?.status === "running"
    ) {
      return null;
    }

    const settings = yield* serverSettingsService.getSettings;
    const resolved = resolveProjectSettings(settings, input.thread.projectId);
    // Automatic routing is opt-in per project. Environment defaults never form a pool.
    if (resolved.sources.providerRoutingPolicy !== "project") {
      return null;
    }

    const providers = yield* providerRegistry.getProviders;
    const currentProvider = providers.find(
      (provider) => provider.instanceId === currentSelection.instanceId,
    );
    if (!currentProvider) {
      return null;
    }
    const instanceIds =
      resolved.settings.providerRoutingPolicy.instanceIdsByDriver[currentProvider.driver] ?? [];
    const providerHealthRefreshInterval = Duration.toMillis(
      resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    );
    const maxUsageAgeMs = Math.max(
      Duration.toMillis(MIN_PROVIDER_USAGE_FRESHNESS),
      providerHealthRefreshInterval * 2,
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const usageThresholdPercent = resolved.settings.providerRoutingPolicy.usageThresholdPercent;
    const routingConfigured =
      usageThresholdPercent !== null &&
      Number.isInteger(usageThresholdPercent) &&
      usageThresholdPercent >= 1 &&
      usageThresholdPercent <= 100 &&
      new Set(instanceIds).size >= 2;
    if (!instanceIds.includes(currentSelection.instanceId) || !routingConfigured) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("provider-account-routing-invalid"),
        threadId: input.thread.id,
        providerRoutingMode: "fixed",
      });
      if (isProviderAccountConfirmedUnusable(currentProvider, { nowMs, maxUsageAgeMs })) {
        yield* appendProviderFailureActivity({
          threadId: input.thread.id,
          kind: "provider.account.route.failed",
          summary: "Provider account switch failed",
          detail: "Automatic switching is not fully configured. The message was not sent.",
          turnId: null,
          createdAt: input.createdAt,
          requestId: input.messageId,
          terminalTurnStart: true,
        });
        return PROVIDER_ACCOUNT_ROUTING_BLOCKED;
      }
      return null;
    }
    const decision = selectAutomaticProviderAccount({
      routingMode: "auto",
      instanceIds,
      usageThresholdPercent,
      threadHasStarted: input.thread.latestTurn !== null,
      modelSelection: currentSelection,
      providers,
      nowMs,
      maxUsageAgeMs,
    });
    if (decision === null) {
      if (isProviderAccountConfirmedUnusable(currentProvider, { nowMs, maxUsageAgeMs })) {
        yield* appendProviderFailureActivity({
          threadId: input.thread.id,
          kind: "provider.account.route.failed",
          summary: "Provider account switch failed",
          detail: "No eligible provider account is available. The message was not sent.",
          turnId: null,
          createdAt: input.createdAt,
          requestId: input.messageId,
          terminalTurnStart: true,
        });
        return PROVIDER_ACCOUNT_ROUTING_BLOCKED;
      }
      return null;
    }

    const targetRoutingMode = currentProvider.driver === "claudeAgent" ? "fixed" : "auto";
    let lastStartFailureDetail: string | null = null;
    let targetSelection: ModelSelection | null = null;
    for (const targetInstanceId of decision.targetInstanceIds) {
      const attemptedSelection: ModelSelection = {
        ...currentSelection,
        instanceId: ProviderInstanceId.make(targetInstanceId),
      };
      const started = yield* ensureSessionForThread(input.thread.id, input.createdAt, {
        modelSelection: attemptedSelection,
        pendingTurnStart: true,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          lastStartFailureDetail = formatFailureDetail(cause);
          return Effect.logWarning("provider account candidate failed to start", {
            threadId: input.thread.id,
            targetInstanceId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false));
        }),
      );
      if (started) {
        targetSelection = attemptedSelection;
        break;
      }
    }

    if (targetSelection === null) {
      const terminalTurnStart = isProviderAccountConfirmedUnusable(currentProvider, {
        nowMs,
        maxUsageAgeMs,
      });
      yield* appendProviderFailureActivity({
        threadId: input.thread.id,
        kind: "provider.account.route.failed",
        summary: "Provider account switch failed",
        detail: lastStartFailureDetail ?? "No eligible provider account could be started.",
        turnId: null,
        createdAt: input.createdAt,
        requestId: input.messageId,
        ...(terminalTurnStart ? { terminalTurnStart: true as const } : {}),
      });
      if (terminalTurnStart) {
        return PROVIDER_ACCOUNT_ROUTING_BLOCKED;
      }
      return currentSelection;
    }

    const targetProvider = providers.find(
      (provider) => provider.instanceId === targetSelection?.instanceId,
    );

    return yield* Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.provider-account.route",
        commandId: yield* serverCommandId("provider-account-route"),
        threadId: input.thread.id,
        previousProviderInstanceId: currentSelection.instanceId,
        modelSelection: targetSelection,
        providerRoutingMode: targetRoutingMode,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.account.routed",
          summary:
            decision.reason === "initial-placement"
              ? "Selected provider account"
              : "Switched provider account",
          payload: {
            previousProviderInstanceId: currentSelection.instanceId,
            providerInstanceId: targetSelection.instanceId,
            providerName: currentProvider.driver === "claudeAgent" ? "Claude" : "Codex",
            previousProviderInstanceLabel: currentProvider.displayName,
            providerInstanceLabel: targetProvider?.displayName ?? targetSelection.instanceId,
            initialPlacement: decision.reason === "initial-placement",
            reason: decision.reason,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      threadModelSelections.set(input.thread.id, targetSelection);
      return targetSelection;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* appendProviderFailureActivity({
                threadId: input.thread.id,
                kind: "provider.account.route.failed",
                summary: "Provider account switch failed",
                detail: formatFailureDetail(cause),
                turnId: null,
                createdAt: input.createdAt,
                requestId: input.messageId,
              }).pipe(
                Effect.catchCause((activityCause) =>
                  Effect.logWarning("failed to record provider account switch failure", {
                    threadId: input.thread.id,
                    cause: Cause.pretty(activityCause),
                    originalCause: Cause.pretty(cause),
                  }),
                ),
              );
              // A failed durable commit must restore the provider binding before this prompt
              // can fall back to the previously selected account.
              const latestThread = yield* resolveThreadShell(input.thread.id);
              const fallbackSelection = latestThread?.modelSelection ?? currentSelection;
              yield* ensureSessionForThread(input.thread.id, input.createdAt, {
                modelSelection: fallbackSelection,
                pendingTurnStart: true,
                ...(latestThread?.latestTurn === null
                  ? { allowIncompatibleUnstartedReplacement: true as const }
                  : {}),
              });
              threadModelSelections.set(input.thread.id, fallbackSelection);
              return fallbackSelection;
            }),
      ),
    );
  });

  const fixClaudeRoutingAfterInitialPlacement = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (
      thread?.providerRoutingMode !== "auto" ||
      thread.latestTurn !== null ||
      (yield* providerService.getInstanceInfo(input.modelSelection.instanceId)).driverKind !==
        "claudeAgent"
    ) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("claude-initial-account-placement"),
      threadId: input.threadId,
      providerRoutingMode: "fixed",
    });
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    readonly reconcileDurableSelection?: boolean;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const sessionModelSelection =
      input.modelSelection ??
      (input.reconcileDurableSelection === true ? thread.modelSelection : undefined);
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(sessionModelSelection !== undefined ? { modelSelection: sessionModelSelection } : {}),
      pendingTurnStart: true,
      ...(input.reconcileDurableSelection === true && thread.latestTurn === null
        ? { allowIncompatibleUnstartedReplacement: true as const }
        : {}),
    });
    if (sessionModelSelection !== undefined) {
      threadModelSelections.set(input.threadId, sessionModelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      requestId: input.messageId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const associatePendingTurnAdmission = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly turnId: TurnId;
    readonly settled: boolean;
  }) {
    const getPendingTurnStart = projectionSnapshotQuery.getPendingTurnStartByThreadId;
    if (getPendingTurnStart === undefined) return;
    const pending = yield* getPendingTurnStart(input.threadId);
    if (Option.isNone(pending) || pending.value.messageId !== input.messageId) return;
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread?.session) return;
    const previousSession = thread.session;
    const admittedAt = DateTime.formatIso(yield* DateTime.now);
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...previousSession,
        status: "running",
        activeTurnId: input.turnId,
        lastError: null,
        updatedAt: admittedAt,
      },
      createdAt: admittedAt,
    });
    if (input.settled || previousSession.status === "ready") {
      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          ...previousSession,
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: admittedAt,
        },
        createdAt: admittedAt,
      });
    }
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.title.generate.complete",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
          expectedTitle: input.expectedTitle,
          expectedVersion: input.expectedVersion,
          needsRefinement:
            generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to regenerate thread title", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const)),
        ),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor retrying title regeneration completion", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion))),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to complete title regeneration", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    options?: { readonly recovery?: true },
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    const key = turnStartKeyForEvent(event);
    if (options?.recovery !== true && (yield* hasHandledTurnStartRecently(key))) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const { message, hasOtherUserMessages } = turnStart.value;
    const isCompactCommand = isCompactCommandMessage(message);
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
      return yield* appendTurnStartFailure(
        "Queued message was not sent",
        "The queued message was canceled before it could resume. Send it again to continue.",
      );
    }
    const queuedDuringCompaction =
      resumed === undefined &&
      (compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId));
    const getPendingTurnStart = projectionSnapshotQuery.getPendingTurnStartByThreadId;
    let pendingTurnStart =
      getPendingTurnStart === undefined
        ? Option.none()
        : yield* getPendingTurnStart(event.payload.threadId);
    if (!queuedDuringCompaction && Option.isNone(pendingTurnStart)) {
      const claimed = yield* projectionTurnRepository.insertPendingTurnStartIfAbsent({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
        sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
        requestedAt: event.payload.createdAt,
      });
      if (claimed) {
        pendingTurnStart = Option.some({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
          sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
          requestedAt: event.payload.createdAt,
        });
      } else if (getPendingTurnStart !== undefined) {
        pendingTurnStart = yield* getPendingTurnStart(event.payload.threadId);
      }
    }
    if (
      !queuedDuringCompaction &&
      (Option.isNone(pendingTurnStart) ||
        pendingTurnStart.value.messageId !== event.payload.messageId)
    ) {
      return yield* appendTurnStartFailure(
        "Message was not sent",
        "Another message is still waiting to start. Retry after it connects.",
      );
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() => appendTurnStartFailure("Provider turn start failed", detail)),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const authCommandHandled = yield* Effect.gen(function* () {
      // Native account commands belong to the thread's existing provider session.
      const instanceId =
        thread.session?.providerInstanceId ??
        event.payload.modelSelection?.instanceId ??
        thread.modelSelection.instanceId;
      const handled = yield* providerAuthService.tryHandlePromptCommand({
        instanceId,
        text: message.text,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });
      if (!handled) {
        return false;
      }

      const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: instanceInfo.driverKind,
          ...(thread.session?.providerSessionId !== undefined
            ? { providerSessionId: thread.session.providerSessionId }
            : {}),
          providerInstanceId: instanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provider-sign-out"),
        threadId: thread.id,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.auth.signed-out",
          summary: "Provider signed out",
          payload: { providerInstanceId: instanceId },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return true;
    }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))));
    if (authCommandHandled) {
      return;
    }

    yield* ensureThreadWorktree(thread);

    if (!hasOtherUserMessages && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (
        thread.titleState?.source !== "manual" &&
        canReplaceThreadTitle(thread.title, event.payload.titleSeed)
      ) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          expectedTitle: thread.title,
          expectedVersion: thread.titleState?.version ?? null,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    let compactionSessionEnsured = false;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
          Effect.asVoid,
        );
      }
      return appendTurnStartFailure("Context compaction failed", detail).pipe(
        Effect.ensuring(
          restoreCompaction(event.payload.threadId).pipe(
            Effect.catchCause((restoreCause) =>
              Effect.logWarning("failed to restore provider session after compaction failure", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(restoreCause),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover compaction failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running"
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      yield* Effect.gen(function* () {
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.payload.createdAt,
          event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
            : { pendingTurnStart: true },
        );
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
      }).pipe(
        Effect.andThen(restoreCompaction(event.payload.threadId, true)),
        Effect.andThen(clearCompacting),
        Effect.andThen(resumeTurnsAfterCompaction(event.payload.threadId)),
        Effect.catchCause((cause) =>
          recoverCompactionFailure(cause).pipe(
            Effect.ensuring(clearCompacting),
            Effect.andThen(
              cancelTurnsAfterCompaction(
                event.payload.threadId,
                "Context compaction failed. Send this message again to continue.",
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return;
    }
    if (queuedDuringCompaction) {
      const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
      queued.push(event);
      turnsAfterCompaction.set(event.payload.threadId, queued);
      return;
    }
    const routedModelSelection = yield* maybeRouteProviderAccount({
      thread,
      ...(event.payload.modelSelection !== undefined
        ? { requestedModelSelection: event.payload.modelSelection }
        : {}),
      messageId: event.payload.messageId,
      createdAt: event.payload.createdAt,
      resumed: resumed !== undefined,
      allow: event.payload.allowProviderAccountRouting === true,
    });
    if (routedModelSelection === PROVIDER_ACCOUNT_ROUTING_BLOCKED) {
      return;
    }
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      messageText:
        event.payload.providerInput ??
        projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(routedModelSelection !== null
        ? { modelSelection: routedModelSelection }
        : event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
      reconcileDurableSelection: options?.recovery === true,
    }).pipe(
      Effect.asSome,
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    const placedModelSelection =
      routedModelSelection ?? event.payload.modelSelection ?? thread.modelSelection;
    const placementPersisted = yield* fixClaudeRoutingAfterInitialPlacement({
      threadId: event.payload.threadId,
      modelSelection: placedModelSelection,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(false))),
    );
    if (!placementPersisted) {
      return;
    }

    const pendingSendKey = `${event.payload.threadId}:${event.payload.messageId}`;
    if (pendingTurnSends.has(pendingSendKey) || admittedPendingTurns.has(pendingSendKey)) {
      return;
    }
    pendingTurnSends.add(pendingSendKey);
    const send = providerService.sendTurn(sendTurnRequest.value).pipe(
      Effect.tap((turn) =>
        associatePendingTurnAdmission({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          turnId: turn.turnId,
          settled: false,
        }),
      ),
      Effect.tap(() => Effect.sync(() => void admittedPendingTurns.add(pendingSendKey))),
      Effect.asVoid,
      Effect.catchCause(recoverTurnStartFailure),
      Effect.ensuring(Effect.sync(() => void pendingTurnSends.delete(pendingSendKey))),
    );
    // The forked send settles `sent` from here on, so drop the entry the post-processing hook uses.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
    yield* send.pipe(
      Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
      Effect.forkScoped,
    );
  });

  const findPersistedTurnStart = Effect.fn("findPersistedTurnStart")(function* (pending: {
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) {
    const head = yield* orchestrationEngine.latestSequence;
    return yield* orchestrationEngine
      .readThreadEvents({
        threadId: pending.threadId,
        fromSequenceExclusive: 0,
        toSequenceInclusive: head,
        limit: Number.MAX_SAFE_INTEGER,
      })
      .pipe(
        Stream.filter(
          (event): event is Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }> =>
            event.type === "thread.turn-start-requested" &&
            event.payload.messageId === pending.messageId,
        ),
        Stream.runLast,
      );
  });

  const reconcilePendingTurn = Effect.fn("reconcilePendingTurn")(function* (threadId: ThreadId) {
    if (pendingTurnReconciliations.has(threadId)) return;
    pendingTurnReconciliations.add(threadId);
    yield* Effect.gen(function* () {
      const thread = yield* resolveThreadShell(threadId);
      if (
        !thread?.session ||
        (thread.session.status !== "starting" && thread.session.status !== "ready")
      ) {
        return;
      }
      const getPendingTurnStart = projectionSnapshotQuery.getPendingTurnStartByThreadId;
      const getTurnState = projectionSnapshotQuery.getTurnStateById;
      if (getPendingTurnStart === undefined || getTurnState === undefined) return;
      const pending = yield* getPendingTurnStart(threadId);
      if (Option.isNone(pending)) {
        yield* clearAdmittedPendingTurns(threadId);
        return;
      }
      const pendingSendKey = `${threadId}:${pending.value.messageId}`;
      if (pendingTurnSends.has(pendingSendKey) || admittedPendingTurns.has(pendingSendKey)) return;

      const nowMs = yield* Clock.currentTimeMillis;
      const recoveryAnchorMs = Math.max(
        DateTime.toEpochMillis(DateTime.makeUnsafe(pending.value.requestedAt)),
        DateTime.toEpochMillis(DateTime.makeUnsafe(thread.session.updatedAt)),
      );
      if (nowMs - recoveryAnchorMs < Duration.toMillis(STARTING_SESSION_RECOVERY_TIMEOUT)) return;

      const persistedAdmission = yield* (
        providerService.getPersistedTurnAdmission?.(threadId) ?? Effect.succeed(null)
      );
      if (persistedAdmission?.messageId === pending.value.messageId) {
        const liveSessions = yield* providerService.listSessions();
        const providerStillRunsAdmission = liveSessions.some(
          (session) =>
            session.threadId === threadId && session.activeTurnId === persistedAdmission.turnId,
        );
        if (persistedAdmission.active && !providerStillRunsAdmission) {
          if (
            liveSessions.some(
              (session) => session.threadId === threadId && session.activeTurnId != null,
            )
          ) {
            return;
          }
          const cleared = yield* (
            providerService.clearOrphanedTurnAdmissionIfMatches?.({
              threadId,
              messageId: pending.value.messageId,
              turnId: persistedAdmission.turnId,
            }) ?? Effect.succeed(false)
          );
          if (!cleared) return;

          const failedAt = DateTime.formatIso(yield* DateTime.now);
          const latestThread = yield* resolveThreadShell(threadId);
          if (!latestThread?.session) return;
          yield* setThreadSession({
            threadId,
            session: {
              ...latestThread.session,
              status: "ready",
              activeTurnId: null,
              lastError: null,
              updatedAt: failedAt,
            },
            createdAt: failedAt,
          });
          yield* appendProviderFailureActivity({
            threadId,
            kind: "provider.turn.start.failed",
            summary: "Message delivery could not be confirmed",
            detail:
              "The provider session ended after accepting this message. It may have been sent, so T3 did not send it again. Retry the message if no response appears.",
            turnId: null,
            createdAt: failedAt,
            requestId: pending.value.messageId,
          });
          return;
        }
        yield* associatePendingTurnAdmission({
          threadId,
          messageId: pending.value.messageId,
          turnId: persistedAdmission.turnId,
          settled: !persistedAdmission.active && !providerStillRunsAdmission,
        });
        return;
      }

      const liveSession = (yield* providerService.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      if (liveSession?.activeTurnId != null) {
        const turnState = yield* getTurnState(threadId, liveSession.activeTurnId);
        if (Option.isNone(turnState) || !TERMINAL_TURN_STATES.has(turnState.value)) return;
        // The adapter still reports a turn the durable projection has already
        // settled. Restart it before replaying the pending request.
        yield* providerService.stopSession({ threadId });
      }

      const reconcilePersistedActiveTurn = providerService.reconcilePersistedActiveTurn;
      let persistedRuntime = yield* (
        reconcilePersistedActiveTurn?.({
          threadId,
          terminalTurnIds: new Set(),
        }) ?? Effect.succeed({ status: "idle" as const })
      );
      if (persistedRuntime.status === "active") {
        const turnState = yield* getTurnState(threadId, persistedRuntime.turnId);
        if (Option.isNone(turnState) || !TERMINAL_TURN_STATES.has(turnState.value)) return;
        persistedRuntime = yield* (
          reconcilePersistedActiveTurn?.({
            threadId,
            terminalTurnIds: new Set([persistedRuntime.turnId]),
          }) ?? Effect.succeed({ status: "idle" as const })
        );
        if (persistedRuntime.status === "active") return;
      }

      const latestPending = yield* getPendingTurnStart(threadId);
      if (
        Option.isNone(latestPending) ||
        latestPending.value.messageId !== pending.value.messageId
      ) {
        return;
      }
      const originalEvent = yield* findPersistedTurnStart({
        threadId,
        messageId: pending.value.messageId,
      });
      if (Option.isNone(originalEvent)) return;
      const latestThread = yield* resolveThreadShell(threadId);
      if (!latestThread) return;
      // Recheck the adapter immediately before replay. A reconnect can restore
      // an admitted turn while the durable projection queries above are in flight.
      if (
        (yield* providerService.listSessions()).some(
          (session) => session.threadId === threadId && session.activeTurnId != null,
        )
      ) {
        return;
      }
      let recoveredEvent = originalEvent.value;
      if (
        originalEvent.value.payload.modelSelection !== undefined &&
        originalEvent.value.payload.modelSelection.instanceId !==
          latestThread.modelSelection.instanceId
      ) {
        const { allowProviderAccountRouting: _, ...payloadWithoutRoutingConsent } =
          originalEvent.value.payload;
        recoveredEvent = {
          ...originalEvent.value,
          payload: {
            ...payloadWithoutRoutingConsent,
            modelSelection: latestThread.modelSelection,
          },
        };
      }
      yield* processTurnStartRequested(recoveredEvent, { recovery: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("pending provider turn reconciliation failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(Effect.sync(() => void pendingTurnReconciliations.delete(threadId))),
    );
  });

  const pendingTurnReconciliationWorker = yield* makeDrainableWorker(reconcilePendingTurn);
  const scheduledPendingTurnReconciliations = new Set<ThreadId>();
  const clearAdmittedPendingTurns = (threadId: ThreadId) =>
    Effect.sync(() => {
      const prefix = `${threadId}:`;
      for (const key of admittedPendingTurns) {
        if (key.startsWith(prefix)) admittedPendingTurns.delete(key);
      }
    });
  const schedulePendingTurnReconciliation = (
    threadId: ThreadId,
    delay = STARTING_SESSION_RECOVERY_TIMEOUT,
  ) => {
    if (scheduledPendingTurnReconciliations.has(threadId)) return Effect.void;
    scheduledPendingTurnReconciliations.add(threadId);
    return forkParked(
      Effect.sleep(delay).pipe(
        Effect.andThen(pendingTurnReconciliationWorker.enqueue(threadId)),
        Effect.ensuring(
          Effect.sync(() => void scheduledPendingTurnReconciliations.delete(threadId)),
        ),
      ),
    );
  };

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    yield* cancelTurnsAfterCompaction(
      event.payload.threadId,
      "Context compaction was interrupted. Send this message again to continue.",
    );
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId
            ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const resolveGuardedStopThread = Effect.fn("resolveGuardedStopThread")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const currentSequence = yield* orchestrationEngine.latestSequence;
    const replayStats = yield* orchestrationEngine.getThreadReplayStats({
      threadId: event.payload.threadId,
      fromSequenceExclusive: event.sequence,
      toSequenceInclusive: currentSequence,
      maxEvents: 0,
    });
    const thread = yield* resolveThreadShell(event.payload.threadId);
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      replayStats.eventCount > 0 ||
      !thread ||
      event.payload.expectedProviderName === undefined ||
      event.payload.expectedProviderSessionId === undefined ||
      !canStopThreadSessionIfIdle({
        expectedProviderName: event.payload.expectedProviderName,
        expectedProviderSessionId: event.payload.expectedProviderSessionId,
        session: thread.session,
        latestTurnState: thread.latestTurn?.state ?? null,
        hasQueuedTurnStart: threadHasQueuedTurnStart(thread, now),
        hasPendingRequests: thread.hasPendingApprovals || thread.hasPendingUserInput,
        backgroundLiveness: thread.backgroundLiveness ?? null,
      })
    ) {
      return undefined;
    }
    return thread;
  });

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    let thread =
      event.payload.onlyIfIdle === true
        ? yield* resolveGuardedStopThread(event)
        : yield* resolveThreadShell(event.payload.threadId);
    if (!thread) return;

    const now = event.payload.createdAt;
    const wasCompacting = compactingThreadIds.has(thread.id);
    stoppingThreadIds.add(thread.id);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
    const stopProviderSession =
      thread.session && thread.session.status !== "stopped"
        ? event.payload.onlyIfIdle === true
          ? providerService.stopSessionIfCurrent
            ? resolveGuardedStopThread(event).pipe(
                Effect.flatMap((currentThread) =>
                  currentThread
                    ? providerService.stopSessionIfCurrent!({
                        threadId: currentThread.id,
                        expectedProviderName: event.payload.expectedProviderName!,
                        expectedProviderSessionId: event.payload.expectedProviderSessionId!,
                      })
                    : Effect.succeed(false),
                ),
              )
            : Effect.logWarning("provider.session.stop-guard-unsupported", {
                threadId: thread.id,
                provider: event.payload.expectedProviderName,
              }).pipe(Effect.as(false))
          : providerService.stopSession({ threadId: thread.id }).pipe(Effect.as(true))
        : Effect.succeed(true);
    const cancelCompactedTurns = cancelTurnsAfterCompaction(
      thread.id,
      "The session was stopped during context compaction. Send this message again to continue.",
    );
    const stopSession =
      event.payload.onlyIfIdle === true
        ? stopProviderSession.pipe(
            Effect.flatMap((stopped) =>
              stopped ? cancelCompactedTurns.pipe(Effect.as(true)) : Effect.succeed(false),
            ),
          )
        : cancelCompactedTurns.pipe(Effect.andThen(stopProviderSession));
    yield* stopSession.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail = formatFailureDetail(cause);
          return Effect.sync(() => {
            stoppingThreadIds.delete(thread.id);
            return wasCompacting && !compactingThreadIds.has(thread.id);
          }).pipe(
            Effect.flatMap((compactionSettled) =>
              compactionSettled ? restoreCompaction(thread.id) : Effect.void,
            ),
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: thread.id,
                kind: "provider.session.stop.failed",
                summary: "Provider session stop failed",
                detail,
                turnId: null,
                createdAt: now,
              }),
            ),
          );
        },
        onSuccess: (stopped) =>
          stopped
            ? setThreadSession({
                threadId: thread.id,
                ...(event.payload.onlyIfIdle === true
                  ? { expectedProviderSessionId: event.payload.expectedProviderSessionId! }
                  : {}),
                session: {
                  threadId: thread.id,
                  status: "stopped",
                  providerName: thread.session?.providerName ?? null,
                  ...(thread.session?.providerSessionId !== undefined
                    ? { providerSessionId: thread.session.providerSessionId }
                    : {}),
                  ...(thread.session?.providerInstanceId !== undefined
                    ? { providerInstanceId: thread.session.providerInstanceId }
                    : {}),
                  runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                  activeTurnId: null,
                  lastError: thread.session?.lastError ?? null,
                  updatedAt: now,
                },
                createdAt: now,
              }).pipe(
                Effect.catchTag("OrchestrationGuardedSessionStopRejectedError", () =>
                  Effect.logInfo("provider.session.stop-projection-guard-rejected", {
                    threadId: thread.id,
                    reason: "provider-session-replaced",
                  }),
                ),
              )
            : Effect.logInfo("provider.session.stop-guard-rejected", {
                threadId: thread.id,
                reason: "provider-session-replaced",
              }),
      }),
      Effect.ensuring(clearStopping),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        if (event.payload.regenerateTitle) yield* threadTitleRegenerationWorker.enqueue(event);
        else if (event.payload.titleState?.needsRefinement)
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.session-set":
        if (event.payload.session.status === "ready")
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        const resume = ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        yield* thread.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), resume)
          : resume;
        return;
      }
      case "thread.turn-start-requested": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        yield* thread?.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), processTurnStartRequested(event))
          : processTurnStartRequested(event);
        return;
      }
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.session == null ||
          thread.value.session.status === "stopped"
        ) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // A replay that returned before forking its send still holds its entry; settle it so
      // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
      Effect.ensuring(
        Effect.suspend(() => {
          const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
          return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const reconcilePendingTurns: ProviderCommandReactorShape["reconcilePendingTurns"] = (threadId) =>
    (threadId !== undefined
      ? pendingTurnReconciliationWorker.enqueue(threadId)
      : (projectionSnapshotQuery.listPendingTurnStarts?.() ?? Effect.succeed([])).pipe(
          Effect.flatMap((pendingTurns) =>
            Effect.forEach(
              pendingTurns,
              (pending) => pendingTurnReconciliationWorker.enqueue(pending.threadId),
              { concurrency: 1, discard: true },
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to find pending provider turns for reconciliation", {
              cause: Cause.pretty(cause),
            }),
          ),
        )
    ).pipe(Effect.andThen(pendingTurnReconciliationWorker.drain));

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const pendingTitles = yield* findPendingThreadTitles().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find pending thread titles", {
          failureKind: Cause.hasDies(cause) ? "defect" : "failure",
          reasonCount: cause.reasons.length,
        }).pipe(Effect.as({ interruptedRegenerations: [], refinementThreadIds: [] }));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.regenerateTitle === true ||
            event.payload.titleState?.needsRefinement === true)) ||
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        yield* worker.enqueue(event);
      }
      if (event.type === "thread.turn-start-requested") {
        yield* schedulePendingTurnReconciliation(event.payload.threadId);
      } else if (
        event.type === "thread.meta-updated" &&
        (event.payload.modelSelection !== undefined ||
          event.payload.providerRoutingMode !== undefined)
      ) {
        yield* schedulePendingTurnReconciliation(event.payload.threadId);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        const reconcile =
          event.type === "session.started" ||
          event.type === "session.state.changed" ||
          event.type === "thread.started" ||
          event.type === "turn.started" ||
          event.type === "turn.completed" ||
          event.type === "turn.aborted" ||
          event.type === "session.exited"
            ? schedulePendingTurnReconciliation(event.threadId)
            : Effect.void;
        return reconcile;
      }),
    );

    // A standby server must not resume work while the incumbent is still live.
    // Startup reconciliation is parked at the same activation boundary as the
    // event streams; orphan cleanup separately preserves durable pending starts.
    yield* forkParked(
      Effect.gen(function* () {
        yield* reconcilePendingTurns();
        const pendingTurns = yield* (
          projectionSnapshotQuery.listPendingTurnStarts?.() ?? Effect.succeed([])
        ).pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(
          pendingTurns,
          (pending) => schedulePendingTurnReconciliation(pending.threadId),
          { concurrency: 1, discard: true },
        );
      }),
    );

    // Earlier events do not replay. Clear interrupted requests by their captured
    // IDs, then schedule persisted refinements after subscribing to their events.
    const recoverTitles = clearInterruptedThreadTitleRegenerations(
      pendingTitles.interruptedRegenerations,
    ).pipe(
      Effect.andThen(
        Effect.forEach(pendingTitles.refinementThreadIds, maybeRefineThreadTitle, {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to recover pending thread titles",
          {
            failureKind: Cause.hasDies(cause) ? "defect" : "failure",
            reasonCount: cause.reasons.length,
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* recoverTitles;
    } else {
      yield* forkParked(recoverTitles);
    }
  });

  return {
    start,
    reconcilePendingTurns,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* pendingTurnReconciliationWorker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
