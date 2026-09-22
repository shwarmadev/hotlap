// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderRoutingPolicy,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  ComposerContextId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import {
  ProviderAdapterRequestError,
  ProviderWorkspaceMissingError,
  type ProviderServiceError,
} from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const routingNow = Effect.runSync(DateTime.now);
const ROUTING_NOW_ISO = DateTime.formatIso(routingNow);
const ROUTING_SESSION_RESET_ISO = DateTime.formatIso(DateTime.add(routingNow, { hours: 5 }));
const ROUTING_WEEKLY_RESET_ISO = DateTime.formatIso(DateTime.add(routingNow, { days: 7 }));

const routingCodexProvider = (input: {
  readonly instanceId: string;
  readonly usedPercent: number;
  readonly checkedAt?: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make("codex"),
  displayName: input.instanceId,
  continuation: { groupKey: "codex:home:/shared-codex" },
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: input.checkedAt ?? ROUTING_NOW_ISO,
  availability: "available",
  models: [
    {
      slug: "gpt-5-codex",
      name: "GPT-5 Codex",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: input.checkedAt ?? ROUTING_NOW_ISO,
    windows: [
      {
        id: "primary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: input.usedPercent,
        resetsAt: ROUTING_WEEKLY_RESET_ISO,
      },
    ],
  },
});

const routingClaudeProvider = (input: {
  readonly instanceId: string;
  readonly sessionUsedPercent: number;
  readonly weeklyUsedPercent: number;
}): ServerProvider => ({
  ...routingCodexProvider({ instanceId: input.instanceId, usedPercent: 0 }),
  driver: ProviderDriverKind.make("claudeAgent"),
  continuation: { groupKey: `claude:home:${input.instanceId}` },
  models: [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: null,
    },
  ],
  usageLimits: {
    checkedAt: ROUTING_NOW_ISO,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: input.sessionUsedPercent,
        resetsAt: ROUTING_SESSION_RESET_ISO,
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: input.weeklyUsedPercent,
        resetsAt: ROUTING_WEEKLY_RESET_ISO,
      },
    ],
  },
});

const assistantQuoteText = "Retain the reconnect backoff.";
const assistantCitation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("source-environment"),
  threadId: ThreadId.make("source-thread"),
  messageId: asMessageId("source-message"),
  text: assistantQuoteText,
  start: 0,
  end: assistantQuoteText.length,
  prefix: "",
  suffix: "",
};

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | ProviderSessionDirectory
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly initialTitle?: string;
    readonly deferReactorStart?: boolean;
    readonly threadModelSelection?: ModelSelection;
    readonly threadProviderRoutingMode?: "auto" | "fixed";
    readonly providerRoutingPolicy?: ProviderRoutingPolicy;
    readonly providerSnapshots?: ReadonlyArray<ServerProvider>;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly unreadableHistory?: boolean;
    readonly titleRegenerationCompletionDispatchFailures?: number;
    readonly providerAccountRouteDispatchFailures?: number;
    readonly backgroundLiveness?: "working" | "monitoring";
    readonly titleRegenerationBeforeStart?: "one" | "two";
    readonly serverActivation?: Effect.Effect<void>;
    readonly beforeReadySessionDispatch?: () => Effect.Effect<void>;
    readonly beforeTurnStartDispatch?: () => Effect.Effect<void>;
    readonly afterTurnStartDispatch?: () => Effect.Effect<void>;
    readonly compactThreadEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly interruptTurnEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly stopSessionEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly stopSessionIfCurrentEffect?: () => Effect.Effect<boolean, ProviderAdapterRequestError>;
    readonly startSessionEffect?: (
      session: ProviderSession,
    ) => Effect.Effect<ProviderSession, ProviderServiceError>;
    readonly tryHandlePromptCommandEffect?: ProviderAuthService["Service"]["tryHandlePromptCommand"];
    readonly beforeReactorStart?: (input: {
      readonly engine: OrchestrationEngineService["Service"];
      readonly runtimeSessions: Array<ProviderSession>;
      readonly directory: ProviderSessionDirectory["Service"];
    }) => Promise<void>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const backgroundLiveness = ThreadBackgroundLiveness.make();
    const backgroundLivenessLayer = Layer.succeed(
      ThreadBackgroundLiveness.ThreadBackgroundLivenessService,
      backgroundLiveness,
    );
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const tryHandlePromptCommand = vi.fn<ProviderAuthService["Service"]["tryHandlePromptCommand"]>(
      input?.tryHandlePromptCommandEffect ?? (() => Effect.succeed(false)),
    );
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    let providerSessionDirectoryForTest: ProviderSessionDirectory["Service"] | null = null;
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSessionEffect = input?.startSessionEffect;
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
        Effect.tap((startedSession) =>
          Effect.sync(() => {
            for (let index = runtimeSessions.length - 1; index >= 0; index -= 1) {
              if (runtimeSessions[index]?.threadId === startedSession.threadId) {
                runtimeSessions.splice(index, 1);
              }
            }
            runtimeSessions.push(startedSession);
          }),
        ),
      );
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const compactThread = vi.fn((_: ThreadId) => input?.compactThreadEffect?.() ?? Effect.void);
    const interruptTurn = vi.fn((_: unknown) => input?.interruptTurnEffect?.() ?? Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((stopInput: unknown) =>
      (input?.stopSessionEffect?.() ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const threadId =
              typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
                ? (stopInput as { threadId?: ThreadId }).threadId
                : undefined;
            if (!threadId) {
              return;
            }
            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      ),
    );
    const stopSessionIfCurrent = vi.fn(
      (stopInput: Parameters<NonNullable<ProviderServiceShape["stopSessionIfCurrent"]>>[0]) =>
        (input?.stopSessionIfCurrentEffect?.() ?? Effect.succeed(true)).pipe(
          Effect.tap((stopped) =>
            stopped
              ? Effect.sync(() => {
                  const index = runtimeSessions.findIndex(
                    (session) => session.threadId === stopInput.threadId,
                  );
                  if (index >= 0) {
                    runtimeSessions.splice(index, 1);
                  }
                })
              : Effect.void,
          ),
        ),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const pruneWorktrees = vi.fn((_: { readonly cwd: string }) => Effect.void);
    const createWorktree = vi.fn(
      (input: { readonly refName: string; readonly path: string | null }) =>
        Effect.succeed({ worktree: { path: input.path ?? "", refName: input.refName } }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGeneration["Service"]["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGeneration["Service"]["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = input?.providerSnapshots ?? [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      compactThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      stopSessionIfCurrent,
      listSessions: () => Effect.succeed(runtimeSessions),
      isSessionEventAuthoritative: () => Effect.succeed(true),
      reconcilePersistedActiveTurn: (reconcileInput) =>
        Effect.gen(function* () {
          const directory = providerSessionDirectoryForTest;
          if (directory === null) return { status: "idle" as const };
          const binding = yield* directory.getBinding(reconcileInput.threadId);
          if (Option.isNone(binding)) return { status: "idle" as const };
          const payload = binding.value.runtimePayload;
          const activeTurnId =
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "activeTurnId" in payload &&
            typeof payload.activeTurnId === "string"
              ? TurnId.make(payload.activeTurnId)
              : null;
          if (activeTurnId === null) return { status: "idle" as const };
          if (
            !reconcileInput.terminalTurnIds.has(activeTurnId) ||
            binding.value.providerInstanceId === undefined
          ) {
            return { status: "active" as const, turnId: activeTurnId };
          }
          const cleared = yield* (
            directory.clearActiveTurnIfMatches?.({
              threadId: reconcileInput.threadId,
              providerInstanceId: binding.value.providerInstanceId,
              turnId: activeTurnId,
            }) ?? Effect.succeed(false)
          );
          return cleared
            ? ({ status: "terminal-cleared" as const, turnId: activeTurnId } as const)
            : ({ status: "active" as const, turnId: activeTurnId } as const);
        }),
      getPersistedTurnAdmission: (threadId) =>
        Effect.gen(function* () {
          const directory = providerSessionDirectoryForTest;
          if (directory === null) return null;
          const binding = yield* directory.getBinding(threadId);
          if (Option.isNone(binding)) return null;
          const payload = binding.value.runtimePayload;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload))
            return null;
          const messageId =
            "lastAdmittedMessageId" in payload ? payload.lastAdmittedMessageId : null;
          const turnId = "lastAdmittedTurnId" in payload ? payload.lastAdmittedTurnId : null;
          if (typeof messageId !== "string" || typeof turnId !== "string") return null;
          return {
            messageId: MessageId.make(messageId),
            turnId: TurnId.make(turnId),
            active: "activeTurnId" in payload && payload.activeTurnId === turnId,
          };
        }),
      clearOrphanedTurnAdmissionIfMatches: (clearInput) =>
        Effect.gen(function* () {
          if (
            runtimeSessions.some(
              (session) =>
                session.threadId === clearInput.threadId &&
                session.activeTurnId === clearInput.turnId,
            )
          ) {
            return false;
          }
          const directory = providerSessionDirectoryForTest;
          if (directory === null || directory.clearTurnAdmissionIfMatches === undefined) {
            return false;
          }
          const binding = yield* directory.getBinding(clearInput.threadId);
          if (Option.isNone(binding) || binding.value.providerInstanceId === undefined) {
            return false;
          }
          return yield* directory.clearTurnAdmissionIfMatches({
            ...clearInput,
            providerInstanceId: binding.value.providerInstanceId,
          });
        }),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      assertConversationRollbackSupported: () => unsupported(),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude")
            ? "claudeAgent"
            : raw.startsWith("codex")
              ? "codex"
              : raw.startsWith("antigravity")
                ? "antigravity"
                : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(backgroundLivenessLayer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(backgroundLivenessLayer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    let titleRegenerationCompletionDispatchAttempts = 0;
    let providerAccountRouteDispatchAttempts = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents: engine.readEvents,
          readThreadEvents: engine.readThreadEvents,
          getThreadReplayStats: engine.getThreadReplayStats,
          dispatch: (command) => {
            if (command.type === "thread.provider-account.route") {
              providerAccountRouteDispatchAttempts += 1;
              if (
                providerAccountRouteDispatchAttempts <=
                (input?.providerAccountRouteDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected provider account route commit failure"));
              }
            }
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            const isReplay =
              command.type === "thread.turn.start" &&
              command.commandId.startsWith("server:after-compaction:");
            const before =
              command.type === "thread.session.set" && command.session.status === "ready"
                ? input?.beforeReadySessionDispatch
                : isReplay
                  ? input?.beforeTurnStartDispatch
                  : undefined;
            return (before?.() ?? Effect.void).pipe(
              Effect.andThen(engine.dispatch(command)),
              Effect.tap(() =>
                isReplay ? (input?.afterTurnStartDispatch?.() ?? Effect.void) : Effect.void,
              ),
            );
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          subscribeDomainEvents: engine.subscribeDomainEvents,
          latestSequence: engine.latestSequence,
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provide(ProjectionTurnRepositoryLive),
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        ProviderSessionDirectoryLive.pipe(
          Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
        ),
      ),
      Layer.provide(Layer.mock(ProviderAuthService, { tryHandlePromptCommand })),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
          pruneWorktrees,
          createWorktree,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          refreshPullRequestStatus: () =>
            Effect.die("refreshPullRequestStatus should not be called in this test"),
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest(
          input?.providerRoutingPolicy
            ? {
                projectSettingsOverrides: {
                  [asProjectId("project-1")]: {
                    providerRoutingPolicy: input.providerRoutingPolicy,
                  },
                },
              }
            : {},
        ),
      ),
      Layer.provideMerge(backgroundLivenessLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
    providerSessionDirectoryForTest = directory;
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    if (input?.backgroundLiveness !== undefined) {
      backgroundLiveness.recordTaskLiveness({
        threadId: "thread-1",
        taskId: "background-task",
        taskType: input.backgroundLiveness === "monitoring" ? "monitor" : "agent",
        status: "running",
        kind: "started",
      });
    }
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: input?.initialTitle ?? "Thread",
        modelSelection: modelSelection,
        providerRoutingMode: input?.threadProviderRoutingMode ?? "fixed",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    if (input?.unreadableHistory === true) {
      // Metadata commands must not decode this unrelated message body.
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, turn_id, role, text, attachments_json,
              is_streaming, created_at, updated_at
            ) VALUES (
              'old-unreadable-message', 'thread-1', NULL, 'assistant',
              'Old assistant output', 'invalid json', 0, ${now}, ${now}
            )
          `;
        }),
      );
    }
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    await input?.beforeReactorStart?.({ engine, runtimeSessions, directory });

    scope = await Effect.runPromise(Scope.make("sequential"));
    const reactorScope = scope;
    const startReactor = () =>
      Effect.runPromise(
        reactor
          .start()
          .pipe(
            Scope.provide(reactorScope),
            Effect.provideService(ServerActivation, input?.serverActivation),
          ),
      );
    if (!input?.deferReactorStart) await startReactor();
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      engine,
      reactor,
      snapshotQuery,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      admitTurn: (input?: {
        readonly provider?: ProviderDriverKind;
        readonly providerInstanceId?: ProviderInstanceId;
        readonly turnId?: TurnId;
      }) =>
        runEffect(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-test-admit-${input?.turnId ?? "turn-1"}`),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: input?.provider ?? ProviderDriverKind.make("codex"),
              providerInstanceId: input?.providerInstanceId ?? ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: input?.turnId ?? asTurnId("turn-1"),
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          }),
        ),
      readPendingTurnStarts: () =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly threadId: string }>`
              SELECT thread_id AS "threadId"
              FROM projection_turns
              WHERE turn_id IS NULL AND state = 'pending'
            `;
          }),
        ),
      tryHandlePromptCommand,
      startSession,
      sendTurn,
      compactThread,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopSessionIfCurrent,
      renameBranch,
      pruneWorktrees,
      createWorktree,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      directory,
      emitRuntimeEvent: (event: ProviderRuntimeEvent) =>
        Effect.runPromise(PubSub.publish(runtimeEventPubSub, event)),
      stateDir,
      backgroundLiveness,
      drain,
      startReactor,
      runEffect,
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }

  effectIt.effect.each(["new", "ready", "stopped"] as const)(
    "handles sign-out for a %s thread before worktree repair, text helpers, or startup",
    (sessionStatus) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-personal");
        const handled = yield* Deferred.make<void>();
        const harness = yield* Effect.promise(() =>
          createHarness({
            ...(sessionStatus === "new"
              ? {}
              : {
                  threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
                }),
            tryHandlePromptCommandEffect: () =>
              Deferred.succeed(handled, undefined).pipe(Effect.as(true)),
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        if (sessionStatus !== "new") {
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-sign-out-bound-session"),
            threadId,
            session: {
              threadId,
              providerInstanceId: instanceId,
              providerName: "antigravity",
              status: sessionStatus,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
        }
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-sign-out-worktree"),
          threadId,
          title: "New thread",
          branch: "t3code/1234abcd",
          worktreePath: NodePath.join(harness.stateDir, "missing-worktree"),
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-provider-sign-out"),
          threadId,
          message: {
            messageId: MessageId.make("message-provider-sign-out"),
            role: "user",
            text: "/logout",
            attachments: [],
          },
          modelSelection: {
            instanceId:
              sessionStatus === "new" ? instanceId : ProviderInstanceId.make("antigravity-other"),
            model: "gemini-3.1-pro",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* Deferred.await(handled);
        yield* Effect.promise(() => harness.drain());

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          providerName: "antigravity",
          providerInstanceId: instanceId,
          activeTurnId: null,
          lastError: null,
        });
        expect(thread?.messages.map((message) => message.text)).toEqual(["/logout"]);
        expect(thread?.activities).toContainEqual(
          expect.objectContaining({ kind: "provider.auth.signed-out", tone: "info", turnId: null }),
        );
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
        expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
          instanceId,
          text: "/logout",
          hasAttachments: false,
        });
        expect(harness.pruneWorktrees).not.toHaveBeenCalled();
        expect(harness.createWorktree).not.toHaveBeenCalled();
        expect(harness.generateThreadTitle).not.toHaveBeenCalled();
        expect(harness.generateBranchName).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect("clears a failed sign-out request without sending it as a prompt", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-personal");
      const handled = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          threadModelSelection: { instanceId, model: "gemini-3.1-pro" },
          tryHandlePromptCommandEffect: () =>
            Deferred.succeed(handled, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "logout",
                    detail: "The provider could not sign out. Try again.",
                  }),
                ),
              ),
            ),
        }),
      );
      const threadId = ThreadId.make("thread-1");

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-sign-out-failed"),
        threadId,
        message: {
          messageId: MessageId.make("message-provider-sign-out-failed"),
          role: "user",
          text: "/logout",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(handled);
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: expect.stringContaining("The provider could not sign out. Try again."),
      });
      expect(thread?.activities).toContainEqual(
        expect.objectContaining({ kind: "provider.turn.start.failed", tone: "error" }),
      );
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.auth.signed-out"),
      ).toBe(false);
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect.each([
    { label: "a command mention", text: "What does /logout do?", attachments: [] },
    {
      label: "a command with an attachment",
      text: "/logout",
      attachments: [
        {
          type: "file" as const,
          id: "attached-notes",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        },
      ],
    },
    { label: "another provider's command", text: "/logout", attachments: [] },
  ])("sends $label when the provider auth handler leaves it unhandled", ({ text, attachments }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            Deferred.succeed(started, undefined).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-command-unhandled"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-provider-command-unhandled"),
          role: "user",
          text,
          attachments,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledWith({
        instanceId: ProviderInstanceId.make("codex"),
        text,
        hasAttachments: attachments.length > 0,
      });
      expect(harness.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: text,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      );
    }),
  );

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("keeps an older pending recovery turn when a new prompt arrives", async () => {
    const threadId = ThreadId.make("thread-1");
    const pendingMessageId = MessageId.make("message-pending-recovery");
    const losingMessageId = MessageId.make("message-while-recovering");
    const requestedAt = DateTime.formatIso(Effect.runSync(DateTime.now));
    const harness = await createHarness({
      beforeReactorStart: async ({ engine }) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-pending-recovery"),
            threadId,
            message: {
              messageId: pendingMessageId,
              role: "user",
              text: "recover this message first",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: requestedAt,
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-pending-recovery-starting"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: requestedAt,
            },
            createdAt: requestedAt,
          }),
        );
      },
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-while-recovering"),
        threadId,
        message: {
          messageId: losingMessageId,
          role: "user",
          text: "do not replace the pending recovery",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: requestedAt,
      }),
    );
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.start.failed" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            "requestId" in activity.payload &&
            activity.payload.requestId === losingMessageId,
        ) === true
      );
    });
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
    const pending = await harness.runEffect(
      harness.snapshotQuery.getPendingTurnStartByThreadId?.(threadId) ??
        Effect.succeed(Option.none()),
    );
    expect(Option.getOrThrow(pending).messageId).toBe(pendingMessageId);
    expect(harness.tryHandlePromptCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "do not replace the pending recovery" }),
    );
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("durably claims a later prompt after the first pending prompt settles", async () => {
    const releaseSignOut = await Effect.runPromise(Deferred.make<void>());
    const firstMessageId = MessageId.make("message-sign-out-before-later-prompt");
    const secondMessageId = MessageId.make("message-after-sign-out");
    const harness = await createHarness({
      tryHandlePromptCommandEffect: ({ text }) =>
        text === "/logout"
          ? Deferred.await(releaseSignOut).pipe(Effect.as(true))
          : Effect.succeed(false),
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-sign-out-before-later-prompt"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: firstMessageId,
          role: "user",
          text: "/logout",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitFor(() => harness.tryHandlePromptCommand.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-after-sign-out"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: secondMessageId,
          role: "user",
          text: "continue after signing out",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await harness.runEffect(Deferred.succeed(releaseSignOut, undefined));
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: "continue after signing out" }),
    );
    const pending = await harness.runEffect(
      harness.snapshotQuery.getPendingTurnStartByThreadId?.(ThreadId.make("thread-1")) ??
        Effect.succeed(Option.none()),
    );
    expect(Option.getOrThrow(pending).messageId).toBe(secondMessageId);
  });

  it("relaunches one pending turn after activation when an older terminal runtime turn is stale", async () => {
    const threadId = ThreadId.make("thread-1");
    const staleTurnId = TurnId.make("turn-completed-before-account-switch");
    const newerTurnId = TurnId.make("turn-completed-after-stale-turn");
    const pendingMessageId = MessageId.make("message-after-account-switch");
    const activation = await Effect.runPromise(Deferred.make<void>());
    const harness = await createHarness({
      serverActivation: Deferred.await(activation),
      beforeReactorStart: async ({ engine, runtimeSessions, directory }) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-newer-turn-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: newerTurnId,
              lastError: null,
              updatedAt: "2025-12-31T23:59:01.100Z",
            },
            createdAt: "2025-12-31T23:59:01.100Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-newer-turn-completed"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:01.200Z",
            },
            createdAt: "2025-12-31T23:59:01.200Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-stale-turn-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: staleTurnId,
              lastError: null,
              updatedAt: "2025-12-31T23:59:00.000Z",
            },
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-stale-turn-completed"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:01.000Z",
            },
            createdAt: "2025-12-31T23:59:01.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-pending-after-account-switch"),
            threadId,
            message: {
              messageId: pendingMessageId,
              role: "user",
              text: "continue after switching accounts",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: "2025-12-31T23:59:02.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-stuck-starting-after-account-switch"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:02.000Z",
            },
            createdAt: "2025-12-31T23:59:02.000Z",
          }),
        );
        await Effect.runPromise(
          directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "approval-required",
            runtimePayload: { activeTurnId: staleTurnId },
          }),
        );
        runtimeSessions.push({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
          runtimeMode: "approval-required",
          createdAt: "2025-12-31T23:59:00.000Z",
          updatedAt: "2025-12-31T23:59:01.000Z",
        });
      },
    });

    expect(harness.sendTurn).not.toHaveBeenCalled();
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-pending-session-became-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(Deferred.succeed(activation, undefined));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => (await harness.readPendingTurnStarts()).length === 0);

    const repairedBinding = await harness.runEffect(harness.directory.getBinding(threadId));
    expect(Option.getOrThrow(repairedBinding).runtimePayload).toMatchObject({
      activeTurnId: null,
    });

    const reconnectEvent = {
      type: "session.started" as const,
      eventId: EventId.make("evt-duplicate-host-reconnect"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {},
    };
    await Promise.all([
      harness.emitRuntimeEvent(reconnectEvent),
      harness.emitRuntimeEvent({
        ...reconnectEvent,
        eventId: EventId.make("evt-second-duplicate-host-reconnect"),
      }),
    ]);
    await Promise.all([
      harness.runEffect(harness.reactor.reconcilePendingTurns(threadId)),
      harness.runEffect(harness.reactor.reconcilePendingTurns(threadId)),
    ]);
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        input: "continue after switching accounts",
      }),
    );
  });

  it("restores the durable account before relaunching a turn after an interrupted route commit", async () => {
    const threadId = ThreadId.make("thread-1");
    const current = routingClaudeProvider({
      instanceId: "claude-personal",
      sessionUsedPercent: 95,
      weeklyUsedPercent: 95,
    });
    const target = routingClaudeProvider({
      instanceId: "claude-work",
      sessionUsedPercent: 10,
      weeklyUsedPercent: 10,
    });
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: current.instanceId,
        model: "claude-sonnet-5",
      },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 90,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("claudeAgent")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
      beforeReactorStart: async ({ engine, runtimeSessions, directory }) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-pending-interrupted-route"),
            threadId,
            message: {
              messageId: MessageId.make("message-pending-interrupted-route"),
              role: "user",
              text: "continue on the durable account",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            allowProviderAccountRouting: true,
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-starting-before-interrupted-route"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "claudeAgent",
              providerInstanceId: current.instanceId,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:00.000Z",
            },
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: target.instanceId,
            status: "running",
            runtimeMode: "approval-required",
            runtimePayload: null,
          }),
        );
        runtimeSessions.push({
          threadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: target.instanceId,
          status: "ready",
          runtimeMode: "approval-required",
          model: "claude-sonnet-5",
          cwd: "/tmp/provider-project",
          createdAt: "2025-12-31T23:59:00.000Z",
          updatedAt: "2025-12-31T23:59:00.000Z",
        });
      },
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        providerInstanceId: current.instanceId,
        modelSelection: expect.objectContaining({ instanceId: current.instanceId }),
      }),
      { allowIncompatibleUnstartedReplacement: true },
    );
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.providerInstanceId).toBe(current.instanceId);
  });

  it("repairs a durably admitted pending message without sending it again", async () => {
    const threadId = ThreadId.make("thread-1");
    const messageId = MessageId.make("message-already-admitted");
    const turnId = TurnId.make("turn-already-admitted");
    const harness = await createHarness({
      beforeReactorStart: async ({ engine, directory }) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-already-admitted-pending"),
            threadId,
            message: {
              messageId,
              role: "user",
              text: "do not send this twice",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-already-admitted-starting"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:00.000Z",
            },
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "approval-required",
            runtimePayload: {
              activeTurnId: null,
              lastAdmittedMessageId: messageId,
              lastAdmittedTurnId: turnId,
            },
          }),
        );
      },
    });

    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(await harness.readPendingTurnStarts()).toEqual([]);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
    });
  });

  it("fails an ambiguously admitted turn after its provider session disappears", async () => {
    const threadId = ThreadId.make("thread-1");
    const messageId = MessageId.make("message-ambiguous-admission");
    const turnId = TurnId.make("turn-ambiguous-admission");
    const harness = await createHarness({
      deferReactorStart: true,
      beforeReactorStart: async ({ engine, directory }) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-ambiguous-admission-pending"),
            threadId,
            message: {
              messageId,
              role: "user",
              text: "report this uncertain send without replaying it",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-ambiguous-admission-starting"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2025-12-31T23:59:00.000Z",
            },
            createdAt: "2025-12-31T23:59:00.000Z",
          }),
        );
        await Effect.runPromise(
          directory.upsert({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            runtimeMode: "approval-required",
            runtimePayload: {
              activeTurnId: turnId,
              lastAdmittedMessageId: messageId,
              lastAdmittedTurnId: turnId,
            },
          }),
        );
      },
    });

    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(await harness.readPendingTurnStarts()).toEqual([]);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
      lastError: null,
    });
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.turn.start.failed",
        summary: "Message delivery could not be confirmed",
        payload: expect.objectContaining({
          requestId: messageId,
          detail: expect.stringContaining("may have been sent"),
        }),
      }),
    );
    const binding = Option.getOrThrow(
      await harness.runEffect(harness.directory.getBinding(threadId)),
    );
    expect(binding.runtimePayload).toMatchObject({ activeTurnId: null });
    expect(binding.runtimePayload).not.toHaveProperty("lastAdmittedMessageId");
    expect(binding.runtimePayload).not.toHaveProperty("lastAdmittedTurnId");

    await harness.startReactor();
    await harness.emitRuntimeEvent({
      type: "session.started",
      eventId: EventId.make("evt-ambiguous-admission-reconnect"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("routes an idle auto thread to the next configured account before sending", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: current.instanceId,
        model: "gpt-5-codex",
      },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auto-route"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-auto-route"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({
        providerInstanceId: target.instanceId,
        modelSelection: expect.objectContaining({ instanceId: target.instanceId }),
      }),
    );
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ instanceId: target.instanceId }),
      }),
    );
    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );
    expect(thread?.modelSelection.instanceId).toBe(target.instanceId);
    expect(thread?.providerRoutingMode).toBe("auto");
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.account.routed",
        tone: "info",
        payload: expect.objectContaining({
          previousProviderInstanceId: current.instanceId,
          providerInstanceId: target.instanceId,
        }),
      }),
    );
  });

  it("fixes a Claude thread after its one allowed initial placement", async () => {
    const current = routingClaudeProvider({
      instanceId: "claude-personal",
      sessionUsedPercent: 97,
      weeklyUsedPercent: 20,
    });
    const target = routingClaudeProvider({
      instanceId: "claude-work",
      sessionUsedPercent: 20,
      weeklyUsedPercent: 20,
    });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "claude-sonnet-5" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("claudeAgent")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auto-route-claude"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-auto-route-claude"),
          role: "user",
          text: "start",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(target.instanceId);
    expect(thread?.providerRoutingMode).toBe("fixed");
  });

  it("fixes a Claude thread after keeping its initial account", async () => {
    const current = routingClaudeProvider({
      instanceId: "claude-personal",
      sessionUsedPercent: 20,
      weeklyUsedPercent: 20,
    });
    const target = routingClaudeProvider({
      instanceId: "claude-work",
      sessionUsedPercent: 20,
      weeklyUsedPercent: 20,
    });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "claude-sonnet-5" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("claudeAgent")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auto-place-claude-current"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-auto-place-claude-current"),
          role: "user",
          text: "start",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(current.instanceId);
    expect(thread?.providerRoutingMode).toBe("fixed");
    expect(thread?.activities.some((activity) => activity.kind === "provider.account.routed")).toBe(
      false,
    );
  });

  it("does not auto-route without an explicit project policy", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-auto-route-no-policy"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-auto-route-no-policy"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: current.instanceId }),
    );
    expect(harness.startSession).not.toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: target.instanceId }),
    );
  });

  it("fixes an auto thread when its selected account was removed from the project pool", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 20 });
    const firstPoolAccount = routingCodexProvider({ instanceId: "codex-work", usedPercent: 10 });
    const secondPoolAccount = routingCodexProvider({ instanceId: "codex-backup", usedPercent: 5 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 80,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [
            firstPoolAccount.instanceId,
            secondPoolAccount.instanceId,
          ],
        },
      },
      providerSnapshots: [current, firstPoolAccount, secondPoolAccount],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-removed-account"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-removed-account"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.providerRoutingMode).toBe("fixed");
    expect(thread?.modelSelection.instanceId).toBe(current.instanceId);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "threshold is cleared", threshold: null, includeSecond: true },
    { label: "pool has fewer than two accounts", threshold: 80, includeSecond: false },
  ])("fixes an existing auto thread when the $label", async ({ threshold, includeSecond }) => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 20 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 10 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: threshold,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [
            current.instanceId,
            ...(includeSecond ? [target.instanceId] : []),
          ],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-route-invalid-${threshold ?? "unset"}`),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId(`message-route-invalid-${threshold ?? "unset"}`),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect((await harness.readModel()).threads[0]?.providerRoutingMode).toBe("fixed");
  });

  it.each([
    {
      label: "steering",
      messageId: "message-steer",
      sessionStatus: "running" as const,
      allowProviderAccountRouting: true,
    },
    {
      label: "an async input answer",
      messageId: "async-answer:request-1",
      sessionStatus: "ready" as const,
      allowProviderAccountRouting: true,
    },
    {
      label: "a queued prompt",
      messageId: "message-queued",
      sessionStatus: "ready" as const,
      allowProviderAccountRouting: false,
    },
  ])(
    "does not auto-route $label",
    async ({ messageId, sessionStatus, allowProviderAccountRouting }) => {
      const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
      const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
      const harness = await createHarness({
        threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
        threadProviderRoutingMode: "auto",
        providerRoutingPolicy: {
          defaultMode: "auto",
          usageThresholdPercent: 97,
          instanceIdsByDriver: {
            [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
          },
        },
        providerSnapshots: [current, target],
      });
      const createdAt = ROUTING_NOW_ISO;
      const activeTurnId = sessionStatus === "running" ? asTurnId("turn-running") : null;
      const currentSession: ProviderSession = {
        threadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: current.instanceId,
        status: sessionStatus,
        runtimeMode: "approval-required",
        model: "gpt-5-codex",
        cwd: "/tmp/provider-project",
        resumeCursor: { opaque: "current" },
        createdAt,
        updatedAt: createdAt,
      };
      harness.runtimeSessions.push(currentSession);
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-${messageId}-session`),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: sessionStatus,
            providerName: "codex",
            providerInstanceId: current.instanceId,
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );

      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-${messageId}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          ...(allowProviderAccountRouting ? { allowProviderAccountRouting: true as const } : {}),
          createdAt,
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "provider.account.routed",
        ),
      ).toBe(false);
    },
  );

  it("does not auto-route while provider background work is live", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      backgroundLiveness: "working",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-background-route-skip"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-background-route-skip"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: current.instanceId }),
    );
    expect(harness.startSession).not.toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: target.instanceId }),
    );
  });

  it("keeps the current account and sends when the one target start fails", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
      startSessionEffect: (session) =>
        session.providerInstanceId === target.instanceId
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: target.instanceId,
                method: "thread.turn.start",
                detail: "target failed",
              }),
            )
          : Effect.succeed(session),
    });
    const createdAt = ROUTING_NOW_ISO;
    harness.runtimeSessions.push({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: current.instanceId,
      status: "ready",
      runtimeMode: "approval-required",
      model: "gpt-5-codex",
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "current" },
      createdAt,
      updatedAt: createdAt,
    });
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-route-failure-session"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: current.instanceId,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-failure"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession).toHaveBeenCalledWith(
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: target.instanceId }),
    );
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(current.instanceId);
    expect(thread?.session).toMatchObject({
      status: "starting",
      providerInstanceId: current.instanceId,
      lastError: null,
    });
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.account.route.failed", tone: "error" }),
    );
  });

  it("does not send the held prompt when every target fails and the current account is exhausted", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 100 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 90,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
      startSessionEffect: (session) =>
        session.providerInstanceId === target.instanceId
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: target.instanceId,
                method: "thread.turn.start",
                detail: "target failed",
              }),
            )
          : Effect.succeed(session),
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-all-unavailable"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-all-unavailable"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "provider.account.route.failed",
        ) === true,
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await harness.readModel()).threads[0]?.modelSelection.instanceId).toBe(
      current.instanceId,
    );
    expect(await harness.readPendingTurnStarts()).toEqual([]);
  });

  it("does not send to an exhausted account when no eligible target exists", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 100 });
    const unavailableTarget = {
      ...routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 }),
      availability: "unavailable" as const,
    };
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 90,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, unavailableTarget.instanceId],
        },
      },
      providerSnapshots: [current, unavailableTarget],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-no-eligible-target"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-no-eligible-target"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(
      async () =>
        (await harness.readModel()).threads[0]?.activities.some(
          (activity) => activity.kind === "provider.account.route.failed",
        ) === true,
    );
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(await harness.readPendingTurnStarts()).toEqual([]);
  });

  it("tries the next ranked account when the first target cannot start", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const firstTarget = routingCodexProvider({ instanceId: "codex-first", usedPercent: 10 });
    const secondTarget = routingCodexProvider({ instanceId: "codex-second", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [
            secondTarget.instanceId,
            current.instanceId,
            firstTarget.instanceId,
          ],
        },
      },
      providerSnapshots: [current, firstTarget, secondTarget],
      startSessionEffect: (session) =>
        session.providerInstanceId === firstTarget.instanceId
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: firstTarget.instanceId,
                method: "thread.turn.start",
                detail: "first target failed",
              }),
            )
          : Effect.succeed(session),
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-fallback-target"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-fallback-target"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ providerInstanceId: firstTarget.instanceId }),
      expect.objectContaining({ providerInstanceId: secondTarget.instanceId }),
    ]);
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ instanceId: secondTarget.instanceId }),
      }),
    );
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(secondTarget.instanceId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.account.routed",
        payload: expect.objectContaining({ providerInstanceId: secondTarget.instanceId }),
      }),
    );
  });

  it("restores the current account when the atomic route commit fails", async () => {
    const current = routingCodexProvider({ instanceId: "codex-personal", usedPercent: 97 });
    const target = routingCodexProvider({ instanceId: "codex-work", usedPercent: 20 });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "gpt-5-codex" },
      threadProviderRoutingMode: "auto",
      providerAccountRouteDispatchFailures: 1,
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("codex")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-route-commit-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-route-commit-failure"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ providerInstanceId: target.instanceId }),
      expect.objectContaining({ providerInstanceId: current.instanceId }),
    ]);
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ instanceId: current.instanceId }),
      }),
    );
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(current.instanceId);
    expect(thread?.session?.providerInstanceId).toBe(current.instanceId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.account.route.failed", tone: "error" }),
    );
    expect(thread?.activities.some((activity) => activity.kind === "provider.account.routed")).toBe(
      false,
    );
  });

  it("restores the initial Claude account when the atomic route commit fails", async () => {
    const current = routingClaudeProvider({
      instanceId: "claude-personal",
      sessionUsedPercent: 97,
      weeklyUsedPercent: 20,
    });
    const target = routingClaudeProvider({
      instanceId: "claude-work",
      sessionUsedPercent: 20,
      weeklyUsedPercent: 20,
    });
    const harness = await createHarness({
      threadModelSelection: { instanceId: current.instanceId, model: "claude-sonnet-5" },
      threadProviderRoutingMode: "auto",
      providerAccountRouteDispatchFailures: 1,
      providerRoutingPolicy: {
        defaultMode: "auto",
        usageThresholdPercent: 97,
        instanceIdsByDriver: {
          [ProviderDriverKind.make("claudeAgent")]: [current.instanceId, target.instanceId],
        },
      },
      providerSnapshots: [current, target],
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-claude-route-commit-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-claude-route-commit-failure"),
          role: "user",
          text: "start",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        allowProviderAccountRouting: true,
        createdAt: ROUTING_NOW_ISO,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ providerInstanceId: target.instanceId }),
      expect.objectContaining({ providerInstanceId: current.instanceId }),
    ]);
    const rollbackStartInput = harness.startSession.mock.calls[1]?.[1];
    expect(
      typeof rollbackStartInput === "object" &&
        rollbackStartInput !== null &&
        "resumeCursor" in rollbackStartInput
        ? rollbackStartInput.resumeCursor
        : undefined,
    ).toBeUndefined();
    expect(harness.startSession).toHaveBeenNthCalledWith(
      2,
      ThreadId.make("thread-1"),
      expect.objectContaining({ providerInstanceId: current.instanceId }),
      { allowIncompatibleUnstartedReplacement: true },
    );
    expect(harness.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ instanceId: current.instanceId }),
      }),
    );
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.modelSelection.instanceId).toBe(current.instanceId);
    expect(thread?.providerRoutingMode).toBe("fixed");
    expect(thread?.session?.providerInstanceId).toBe(current.instanceId);
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.account.route.failed", tone: "error" }),
    );
    expect(thread?.activities.some((activity) => activity.kind === "provider.account.routed")).toBe(
      false,
    );
  });

  it("sends the durable inherited provider input for a fork continuation", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const sourceThreadId = ThreadId.make("thread-1");
    const sourceTurnId = asTurnId("turn-fork-source");
    const sourceAssistantMessageId = asMessageId("message-fork-source-answer");
    const destinationThreadId = ThreadId.make("thread-fork-destination");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-fork-source-turn"),
        threadId: sourceThreadId,
        message: {
          messageId: asMessageId("message-fork-source-question"),
          role: "user",
          text: "Which setting should we use?",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-provider-fork-source-running"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: sourceTurnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-provider-fork-source-answer-delta"),
        threadId: sourceThreadId,
        messageId: sourceAssistantMessageId,
        delta: "Use the inherited setting.",
        turnId: sourceTurnId,
        createdAt,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-provider-fork-source-answer-complete"),
        threadId: sourceThreadId,
        messageId: sourceAssistantMessageId,
        turnId: sourceTurnId,
        createdAt,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-provider-fork-source-ready"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("cmd-provider-fork-create"),
        threadId: destinationThreadId,
        sourceThreadId,
        sourceMessageId: sourceAssistantMessageId,
        createdAt,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-fork-continuation"),
        threadId: destinationThreadId,
        message: {
          messageId: asMessageId("message-provider-fork-continuation"),
          role: "user",
          text: "Continue from there.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: destinationThreadId,
      input: expect.stringContaining("## Assistant\n\nUse the inherited setting."),
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      input: expect.stringContaining("## New user message\n\nContinue from there."),
    });
  });

  effectIt.effect("projects inline context before sending the provider turn", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-with-context"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-with-context"),
          role: "user",
          text: "Inspect [build](t3-context://v1/terminal/terminal-1)",
          attachments: [],
          context: {
            version: 1,
            records: [
              {
                version: 1,
                kind: "terminal",
                contextId: ComposerContextId.make("terminal-1"),
                label: "build",
                terminalId: "terminal-1",
                terminalLabel: "Build",
                lineStart: 7,
                lineEnd: 7,
                text: "compiled successfully",
              },
            ],
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: expect.stringContaining("[Terminal: build; ref=terminal-1]"),
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: expect.stringContaining('<context kind="terminal" id="terminal-1">'),
      });
    }),
  );

  effectIt.effect("retains a turn dispatched immediately after start until activation", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const started = yield* Deferred.make<ProviderSession>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          serverActivation: Deferred.await(activation),
          startSessionEffect: (session) =>
            Deferred.succeed(started, session).pipe(Effect.as(session)),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-activation"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-before-activation"),
          role: "user",
          text: "Start after activation",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(yield* Deferred.isDone(started)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      const session = yield* Deferred.await(started);
      yield* Effect.promise(() => harness.drain());
      expect(session.threadId).toBe(ThreadId.make("thread-1"));
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.make("thread-1"),
        input: "Start after activation",
      });
    }),
  );

  effectIt.effect("starts a turn and generates its title without loading old message bodies", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const titleGenerated = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          unreadableHistory: true,
          startSessionEffect: (session) =>
            Deferred.succeed(started, undefined).pipe(Effect.as(session)),
        }),
      );
      harness.generateThreadTitle.mockReturnValue(
        Deferred.succeed(titleGenerated, undefined).pipe(Effect.as({ title: "Generated title" })),
      );
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-with-old-history"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-turn-start-with-old-history"),
          role: "user",
          text: "Use the current message",
          attachments: [],
        },
        titleSeed: "Thread",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Deferred.await(started);
      yield* Deferred.await(titleGenerated);
      yield* Effect.promise(() => harness.drain());

      expect(harness.sendTurn).toHaveBeenCalledWith(
        expect.objectContaining({ input: "Use the current message" }),
      );
      expect(harness.generateThreadTitle).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Use the current message" }),
      );
    }),
  );

  effectIt.effect("rejects /compact without conversation context", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-empty-compact"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-empty-compact"),
          role: "user",
          text: "/compact",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.compactThread).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect.each(["resume", "stop before resume", "stop after send"])(
    "queues messages until compaction restores the session (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const stopBeforeResume = scenario === "stop before resume";
        const readyDispatchStarted = yield* Deferred.make<void>();
        const releaseReadyDispatch = yield* Deferred.make<void>();
        const firstSent = yield* Deferred.make<void>();
        const queuedSent = yield* Deferred.make<void>();
        const resumeStarted = yield* Deferred.make<void>();
        const releaseResume = yield* Deferred.make<void>();
        const resumeDispatched = yield* Deferred.make<void>();
        const queuedSendStarted = yield* Deferred.make<void>();
        const releaseQueuedSend = yield* Deferred.make<void>();
        let blockReadyDispatch = false;
        const harness = yield* Effect.promise(() =>
          createHarness({
            beforeTurnStartDispatch: () =>
              stopBeforeResume
                ? Deferred.succeed(resumeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseResume)),
                  )
                : Effect.void,
            afterTurnStartDispatch: () => Deferred.succeed(resumeDispatched, undefined),
            beforeReadySessionDispatch: () =>
              blockReadyDispatch
                ? Deferred.succeed(readyDispatchStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseReadyDispatch)),
                  )
                : Effect.void,
          }),
        );
        const threadId = ThreadId.make("thread-1");
        let sentCount = 0;
        harness.sendTurn.mockImplementation(() =>
          Effect.succeed({ threadId, turnId: asTurnId("turn-1") }).pipe(
            Effect.tap(() => {
              sentCount++;
              return sentCount === 1
                ? Deferred.succeed(firstSent, undefined)
                : sentCount === 2 && scenario === "stop after send"
                  ? Deferred.succeed(queuedSendStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseQueuedSend)),
                    )
                  : sentCount === 3
                    ? Deferred.succeed(queuedSent, undefined)
                    : Effect.void;
            }),
          ),
        );
        const now = "2026-01-01T00:00:00.000Z";
        const dispatchTurn = (id: string, text: string, createdAt: string) =>
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-${id}`),
            threadId,
            message: {
              messageId: asMessageId(`user-message-${id}`),
              role: "user",
              text,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          });

        yield* dispatchTurn("before-blocked-compact", "hello", now);
        yield* Deferred.await(firstSent);
        yield* Effect.promise(() =>
          waitFor(async () => (await harness.readPendingTurnStarts()).length === 0),
        );
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-ready-before-blocked-compact"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        blockReadyDispatch = true;
        yield* dispatchTurn("blocked-compact", "/compact", "2026-01-01T00:00:01.000Z");
        yield* Deferred.await(readyDispatchStarted);

        yield* harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-queued-mode-plan"),
          threadId,
          interactionMode: "plan",
          createdAt: now,
        });
        yield* dispatchTurn("during-compact-recovery", "first queued", "2026-01-01T00:00:02.000Z");
        yield* harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-queued-mode-default"),
          threadId,
          interactionMode: "default",
          createdAt: now,
        });
        yield* dispatchTurn(
          "during-compact-recovery-2",
          "second queued",
          "2026-01-01T00:00:03.000Z",
        );
        yield* Effect.promise(() => harness.drain());
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const beforeRestore = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          beforeRestore?.activities.filter(
            (activity) => activity.kind === "provider.turn.start.failed",
          ),
        ).toEqual([]);
        expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([
          { threadId: "thread-1" },
        ]);

        yield* Deferred.succeed(releaseReadyDispatch, undefined);
        if (scenario === "stop after send") {
          yield* Deferred.await(queuedSendStarted);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-after-queued-send"),
            threadId,
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* Effect.promise(() => harness.drain());
          const stoppedThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(stoppedThread?.session?.status).toBe("stopped");
          expect(
            stoppedThread?.activities.filter(
              (activity) => activity.summary === "Queued message was not sent",
            ),
          ).toEqual([
            expect.objectContaining({
              payload: {
                requestId: "user-message-during-compact-recovery-2",
                detail: expect.any(String),
              },
            }),
          ]);
          expect(harness.sendTurn).toHaveBeenCalledTimes(2);
          yield* Deferred.succeed(releaseQueuedSend, undefined);
          return;
        }
        if (stopBeforeResume) {
          yield* Deferred.await(resumeStarted);
          yield* dispatchTurn("compact-during-resume", "/compact", "2026-01-01T00:00:04.000Z");
          yield* Effect.promise(() => harness.drain());
          expect(harness.compactThread).toHaveBeenCalledTimes(1);
          yield* harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-stop-before-queued-resume"),
            threadId,
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* Effect.promise(() => harness.drain());
          yield* Deferred.succeed(releaseResume, undefined);
          yield* Deferred.await(resumeDispatched);
          yield* Effect.promise(() => harness.drain());
          expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          const stoppedThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
            (entry) => entry.id === threadId,
          );
          expect(stoppedThread?.session?.status).toBe("stopped");
          expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
          expect(
            stoppedThread?.activities.filter(
              (activity) => activity.summary === "Queued message was not sent",
            ),
          ).toHaveLength(2);
          return;
        }
        yield* Deferred.await(queuedSent);
        expect(harness.sendTurn.mock.calls.slice(1).map(([request]) => request)).toEqual([
          expect.objectContaining({ input: "first queued", interactionMode: "plan" }),
          expect.objectContaining({ input: "second queued", interactionMode: "default" }),
        ]);
        const afterRestore = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          afterRestore?.messages.filter((message) => message.text === "first queued"),
        ).toHaveLength(1);
        expect(
          afterRestore?.messages.filter((message) => message.text === "second queued"),
        ).toHaveLength(1);
      }),
  );

  effectIt.effect("does not overwrite concurrent session state after compaction failure", () =>
    Effect.gen(function* () {
      const releaseCompaction = yield* Deferred.make<void>();
      const releaseRunningCompaction = yield* Deferred.make<void>();
      const releaseFailedStop = yield* Deferred.make<void>();
      let compactionCount = 0;
      const harness = yield* Effect.promise(() =>
        createHarness({
          compactThreadEffect: () =>
            Deferred.await(
              compactionCount++ === 0 ? releaseCompaction : releaseRunningCompaction,
            ).pipe(Effect.andThen(Effect.die("Compaction stopped"))),
          stopSessionEffect: () =>
            Deferred.await(releaseFailedStop).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "session.stop",
                    detail: "provider stop failed",
                  }),
                ),
              ),
            ),
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const now = "2026-01-01T00:00:00.000Z";
      const dispatchCompact = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-compact-${suffix}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-compact-${suffix}`),
            role: "user",
            text: "/compact",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-message-before-compact"),
        threadId,
        message: {
          messageId: asMessageId("user-message-before-compact"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      yield* Effect.promise(() =>
        waitFor(async () => (await harness.readPendingTurnStarts()).length === 0),
      );
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-ready-before-compact"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* dispatchCompact("before-stop", now);
      yield* Effect.promise(() => waitFor(() => harness.compactThread.mock.calls.length === 1));
      const compactingThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(compactingThread?.session?.status).toBe("starting");
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-queued-before-stop"),
        threadId,
        message: {
          messageId: asMessageId("user-message-queued-before-stop"),
          role: "user",
          text: "do not restart after stopping",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Effect.promise(() => harness.drain());
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-stop-during-compact"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Effect.promise(() => waitFor(() => harness.stopSession.mock.calls.length === 1));
      yield* Deferred.succeed(releaseCompaction, undefined);
      yield* Effect.promise(() =>
        waitFor(async () => {
          const compactingThread = (await harness.readModel()).threads.find(
            (entry) => entry.id === threadId,
          );
          return (
            compactingThread?.activities.some(
              (activity) => activity.summary === "Context compaction failed",
            ) === true
          );
        }),
      );
      const stoppingThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(stoppingThread?.session?.status).toBe("starting");
      yield* Deferred.succeed(releaseFailedStop, undefined);
      yield* Effect.promise(() => harness.drain());

      const recoveredThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(recoveredThread?.session?.status).toBe("ready");
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(
        recoveredThread?.activities.find(
          (activity) => activity.summary === "Queued message was not sent",
        ),
      ).toMatchObject({
        payload: { requestId: "user-message-queued-before-stop" },
      });
      expect(
        recoveredThread?.activities.find(
          (activity) => activity.kind === "provider.session.stop.failed",
        ),
      ).toMatchObject({
        summary: "Provider session stop failed",
        payload: { detail: "provider stop failed" },
      });

      yield* dispatchCompact("before-running", "2026-01-01T00:00:02.000Z");
      yield* Effect.promise(() => waitFor(() => harness.compactThread.mock.calls.length === 2));
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-failed-stop-before-compaction-settles"),
        threadId,
        createdAt: "2026-01-01T00:00:02.500Z",
      });
      yield* Effect.promise(() =>
        waitFor(async () => {
          const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
          return (
            thread?.activities.filter(
              (activity) => activity.kind === "provider.session.stop.failed",
            ).length === 2
          );
        }),
      );
      const restartedThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(restartedThread?.session?.status).toBe("starting");
      const restartedSession = restartedThread?.session;
      if (!restartedSession) return yield* Effect.die("Compaction session missing");
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-during-compact"),
        threadId,
        session: {
          ...restartedSession,
          status: "running",
          activeTurnId: asTurnId("compaction-turn"),
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      });
      yield* Deferred.succeed(releaseRunningCompaction, undefined);
      yield* Effect.promise(() => harness.drain());
      const runningThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(runningThread?.session?.status).toBe("running");
    }),
  );
  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() => waitFor(() => harness.startSession.mock.calls.length === 1));
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("shows the missing workspace message without a provider stack trace", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const missingCwd = "/missing/project/worktree";
      const missingWorkspace = new ProviderWorkspaceMissingError({
        threadId: ThreadId.make("thread-1"),
        cwd: missingCwd,
      });
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: () =>
            Deferred.succeed(attempted, undefined).pipe(
              Effect.andThen(Effect.fail(missingWorkspace)),
            ),
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-workspace"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-workspace"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(attempted);
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "error",
        activeTurnId: null,
        lastError: missingWorkspace.message,
      });
      const failure = thread?.activities.find(
        (activity) => activity.kind === "provider.turn.start.failed",
      );
      expect(failure?.payload).toMatchObject({ detail: missingWorkspace.message });
      expect(harness.runtimeSessions).toEqual([]);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => harness.readPendingTurnStarts())).toEqual([]);
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        waitFor(async () => {
          const readModel = await harness.readModel();
          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );

  effectIt.effect.each(["before completion", "after completion", "before startup"] as const)(
    "refines a vague title once when initial generation finishes %s",
    (timing) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ deferReactorStart: timing === "before startup" }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = TurnId.make("title-first-turn");
        const createdAt = "2026-01-01T00:00:01.000Z";
        harness.generateThreadTitle.mockReturnValue(
          Effect.succeed({ title: "Fix QR pairing expiry" }),
        );
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("title-turn"),
          threadId,
          message: {
            messageId: MessageId.make("title-user"),
            role: "user",
            text: "Fix this",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* Effect.promise(() => harness.drain());
        const generate = harness.engine.dispatch({
          type: "thread.title.generate.complete",
          commandId: CommandId.make("initial-title"),
          threadId,
          expectedTitle: "Thread",
          expectedVersion: null,
          title: "Investigate issue",
          needsRefinement: true,
        });
        if (timing !== "after completion") yield* generate;
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("title-running"),
          threadId,
          createdAt,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
        });
        yield* harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("title-answer"),
          threadId,
          messageId: MessageId.make("title-assistant"),
          turnId,
          delta: "The QR pairing token expires before the phone redeems it.",
          createdAt,
        });
        const ready = (commandId: string) =>
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(commandId),
            threadId,
            createdAt,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
          });
        yield* ready("title-ready");
        if (timing === "after completion") yield* generate;
        if (timing === "before startup") {
          yield* Effect.promise(harness.startReactor);
        }
        yield* Effect.promise(() => harness.drain());
        if (timing === "before startup") {
          expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
        }
        yield* ready("title-ready-again");
        yield* Effect.promise(() => harness.drain());
        expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
        expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toContain(
          "QR pairing token",
        );
        const thread = (yield* Effect.promise(() => harness.readModel())).threads[0];
        expect(thread?.title).toBe("Fix QR pairing expiry");
        expect(thread?.titleState?.needsRefinement).toBe(false);
      }),
  );

  effectIt.effect("does not replace a manual title matching the first message seed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const threadId = ThreadId.make("thread-1");
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("manual-title"),
        threadId,
        title: "Thread",
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("manual-title-turn"),
        threadId,
        titleSeed: "Thread",
        message: {
          messageId: MessageId.make("manual-title-user"),
          role: "user",
          text: "Fix this",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    }),
  );

  it("retries thread title generation after a transient failure", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    const harness = await createHarness({ initialTitle: seededTitle });
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Claude CLI request timed out.",
              }),
            )
          : Effect.succeed({ title: "Generated title" });
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
    expect(attempts).toBe(2);
  });

  it("regenerates a thread title from the current conversation", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Resolve stale reconnect state" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing"),
        threadId: ThreadId.make("thread-1"),
        title: "Investigate reconnect regressions",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-title-regeneration"),
          role: "user",
          text: "Please investigate reconnect regressions after restarting the session.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        delta: "The remaining issue is stale reconnect state.",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-before-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-before-title-regeneration"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
      previousTitle: "Investigate reconnect regressions",
      message: [
        "USER:",
        "Please investigate reconnect regressions after restarting the session.",
        "",
        "ASSISTANT:",
        "The remaining issue is stale reconnect state.",
      ].join("\n"),
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Resolve stale reconnect state");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user message when regeneration context is truncated", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const quoteText = "界".repeat(1_000);
    const citation = serializeAssistantCitation({
      ...assistantCitation,
      text: quoteText,
      end: quoteText.length,
    });
    const firstUserMessage = `Review subagent monitoring risks. ${citation} ${"Opening context. ".repeat(200)}`;
    const recentUserMessage = `LATEST FINDING: ${"implementation detail ".repeat(320)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Review subagent monitoring risks" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-existing-long"),
        threadId: ThreadId.make("thread-1"),
        title: "Generic PR review",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-long-title-regeneration"),
          role: "user",
          text: firstUserMessage,
          attachments: [
            {
              type: "image",
              id: "opening-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-middle-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("middle-message-before-long-title-regeneration"),
          role: "user",
          text: "Temporary handoff details.",
          attachments: [
            {
              type: "image",
              id: "middle-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recent-turn-before-long-title-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("recent-message-before-long-title-regeneration"),
          role: "user",
          text: recentUserMessage,
          attachments: [
            {
              type: "image",
              id: "recent-context-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-long"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const input = harness.generateThreadTitle.mock.calls[0]?.[0];
    if (!input) {
      throw new Error("Expected a title generation input");
    }
    const message = input.message;
    expect(message).toContain(
      `USER:\nReview subagent monitoring risks. ${quoteText.slice(0, 100)}`,
    );
    expect(message).not.toContain("t3-citation://");
    expect(message).toContain("[Content truncated]");
    expect(message).toContain("[Earlier content truncated]");
    expect(message).toContain("image.png");
    expect(message.length).toBeLessThanOrEqual(8_000);
    expect(input.attachments?.map((attachment) => attachment.id)).toEqual([
      "opening-context-image",
      "middle-context-image",
      "recent-context-image",
    ]);
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find(
          (entry) => entry.id === asMessageId("user-message-before-long-title-regeneration"),
        )?.text,
    ).toBe(firstUserMessage);
  });

  it("clears title regeneration state left pending across reactor startup", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "one",
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Thread");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("continues clearing startup title regeneration state after one completion fails", async () => {
    const harness = await createHarness({
      titleRegenerationBeforeStart: "two",
      titleRegenerationCompletionDispatchFailures: 1,
    });

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(2);
    const readModel = await harness.readModel();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.titleRegeneration,
    ).not.toBeNull();
    expect(
      readModel.threads.find((entry) => entry.id === ThreadId.make("thread-2"))?.titleRegeneration,
    ).toBeNull();
  });

  it("keeps the current title when regeneration returns the fallback", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "New thread" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep meaningful title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-fallback-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-fallback-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep meaningful title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("clears title regeneration state when generation fails", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep title after failure",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-failed-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-failed-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep title after failure");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("retries a failed completion and continues regenerating", async () => {
    const harness = await createHarness({
      titleRegenerationCompletionDispatchFailures: 1,
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle
      .mockReturnValueOnce(Effect.succeed({ title: "Title lost to completion failure" }))
      .mockReturnValueOnce(Effect.succeed({ title: "Recovered regeneration worker" }));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-completion-failure"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    let readModel = await harness.readModel();
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Title lost to completion failure");
    expect(thread?.titleRegeneration).toBeNull();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-after-completion-failure"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(3);
    readModel = await harness.readModel();
    thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Recovered regeneration worker");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("pins the first user context and attachment before the retained tail", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const firstUserContext = "USER:\nOld visual issue\n[Attachments: old-issue.png]";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-truncated-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-truncated-regeneration"),
          role: "user",
          text: "Old visual issue",
          attachments: [
            {
              type: "image",
              id: "old-title-context-image",
              name: "old-issue.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        delta: `content before retained tail${"x".repeat(8_100)}`,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-truncated-regeneration-context-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-truncated-regeneration-context"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regenerate-truncated-context"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );

    await harness.drain();

    const context = harness.generateThreadTitle.mock.calls[0]?.[0].message;
    expect(context).toContain(firstUserContext);
    expect(context).toContain("ASSISTANT:\ncontent before retained tail");
    expect(context?.length).toBeLessThanOrEqual(8_000);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({
        id: "old-title-context-image",
        name: "old-issue.png",
      }),
    ]);
  });

  it("does not overwrite a manual rename while title regeneration is running", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const generatedTitle = await harness.runEffect(
      Deferred.make<{ readonly title: string }, never>(),
    );
    harness.generateThreadTitle.mockReturnValue(Deferred.await(generatedTitle));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-regeneration-race"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-regeneration-race"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const pendingReadModel = await harness.readModel();
    expect(
      pendingReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.titleRegeneration?.requestId,
    ).toBe(CommandId.make("cmd-thread-title-regeneration-race"));

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-during-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep manual rename",
      }),
    );
    await harness.runEffect(
      Deferred.succeed(generatedTitle, { title: "Generated title should not win" }),
    );
    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep manual rename");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite a manual rename while title regeneration is queued", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Generated title should not win" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        title: "Existing thread title",
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-queued-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-queued-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-manual-rename-before-regeneration-starts"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep queued manual rename",
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep queued manual rename");
  });

  it("skips superseded title regeneration before generation starts", async () => {
    let releaseStart = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = await createHarness({
      startSessionEffect: (session) => Effect.promise(() => startGate).pipe(Effect.as(session)),
    });
    const now = "2026-01-01T00:00:00.000Z";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Latest regenerated title" }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-superseded-regeneration"),
          role: "user",
          text: "Investigate the reconnect state.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-superseded-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-latest-regeneration"),
        threadId: ThreadId.make("thread-1"),
        regenerateTitle: true,
      }),
    );
    releaseStart();
    await harness.drain();

    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(harness.titleRegenerationCompletionDispatchAttempts).toBe(1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Latest regenerated title");
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    const harness = await createHarness({ initialTitle: seededTitle });
    const prompt = `[effort:high]\\n\\nFix reconnect spinner on resume ${serializeAssistantCitation(assistantCitation)}`;
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    const titleUpdated = await harness.runEffect(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.meta-updated" &&
            event.payload.title === "Reconnect spinner resume bug",
        ),
        Stream.take(1),
        Stream.toPull,
        Scope.provide(scope!),
      ),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: prompt,
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.runEffect(titleUpdated);
    await harness.drain();

    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(
      `[effort:high]\\n\\nFix reconnect spinner on resume ${assistantQuoteText}`,
    );
    expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).not.toContain("t3-citation://");
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
    expect(
      thread?.messages.find((entry) => entry.id === asMessageId("user-message-title-formatted"))
        ?.text,
    ).toBe(prompt);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: prompt });
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const prompt = `Add a safer reconnect backoff. ${serializeAssistantCitation(assistantCitation)}`;
    const statusRefreshed = await harness.runEffect(Deferred.make<void>());
    const refreshStatus = harness.refreshStatus.getMockImplementation()!;
    harness.refreshStatus.mockImplementation((cwd) =>
      refreshStatus(cwd).pipe(Effect.tap(() => Deferred.succeed(statusRefreshed, undefined))),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: prompt,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.runEffect(Deferred.await(statusRefreshed));
    await harness.drain();
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).toBe(
      `Add a safer reconnect backoff. ${assistantQuoteText}`,
    );
    expect(harness.generateBranchName.mock.calls[0]?.[0].message).not.toContain("t3-citation://");
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
    const readModel = await harness.readModel();
    expect(
      readModel.threads
        .find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.messages.find((entry) => entry.id === asMessageId("user-message-branch-model"))?.text,
    ).toBe(prompt);
  });

  it("recreates a missing worktree from the thread branch before starting a turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const worktreePath = NodePath.join(harness.stateDir, "missing-worktree");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature/restore",
        worktreePath,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-worktree"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-worktree"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-project" });
    expect(harness.createWorktree).toHaveBeenCalledWith(
      {
        cwd: "/tmp/provider-project",
        refName: "feature/restore",
        path: worktreePath,
      },
      { submodules: null },
    );
    expect(harness.createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startSession.mock.invocationCallOrder[0]!,
    );
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-turn-start-unsupported-1-admitted"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-turn-start-restricted-1-admitted"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.admitTurn();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.admitTurn();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.admitTurn({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // Wait for the reactor's own admission rather than racing admitTurn(): its
    // hard-coded approval-required mode, landing after the admission, made the
    // switch below a no-op and this test fail about half the time.
    await waitFor(async () => {
      const session = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      )?.session;
      return session?.status === "running" && session.runtimeMode === "full-access";
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.admitTurn();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  effectIt.effect(
    "stops a running session and records the failure when provider interrupt fails",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            interruptTurnEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            stopSessionEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider process already exited",
                }),
              ),
          }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-interrupt-failure"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-provider-failure"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const thread = (await harness.readModel()).threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return thread?.session?.status === "stopped";
          }),
        );

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );
        expect(thread?.session).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: "provider session disappeared",
        });
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
        ).toMatchObject({
          summary: "Provider turn interrupt failed",
          payload: { detail: "provider session disappeared" },
        });
        expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      }),
  );

  effectIt.effect("stops a starting session without a bound turn when interrupt fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          interruptTurnEffect: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.interrupt",
                detail: "provider session disappeared",
              }),
            ),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-starting"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-starting-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
        lastError: "provider session disappeared",
      });
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toMatchObject({ payload: { detail: "provider session disappeared" } });
    }),
  );

  effectIt.effect("does not overwrite a session that became ready while an interrupt failed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      const completedAt = "2026-01-01T00:00:01.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      harness.interruptTurn.mockImplementation(() =>
        harness.engine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-natural-completion"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          })
          .pipe(
            Effect.catchCause((cause) => Effect.die(cause)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            ),
          ),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toBe(false);
    }),
  );

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("forwards approval responses without reading unrelated message bodies", async () => {
    const harness = await createHarness({ unreadableHistory: true });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("forwards user input answers without reading unrelated message bodies", async () => {
    const harness = await createHarness({ unreadableHistory: true });
    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("normalizes stale Codex approval callbacks without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "item/requestApproval/decision",
          detail: "Unknown pending Codex approval request: approval-request-1",
        }),
      ),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  effectIt.effect("stops a provider session without reading unrelated message bodies", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ unreadableHistory: true }));
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      const thread = yield* harness.snapshotQuery
        .getThreadShellById(ThreadId.make("thread-1"))
        .pipe(Effect.map(Option.getOrThrow));
      expect(thread.session).not.toBeNull();
      expect(thread.session?.status).toBe("stopped");
      expect(thread.session?.threadId).toBe("thread-1");
      expect(thread.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
      expect(thread.session?.activeTurnId).toBeNull();
    }),
  );

  effectIt.effect("stops a ready provider session after automatic settlement", () =>
    Effect.gen(function* () {
      const sessionStopped = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          stopSessionEffect: () => Deferred.succeed(sessionStopped, undefined).pipe(Effect.asVoid),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-auto-settle"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const beforeSettlement = yield* Effect.promise(() => harness.readModel());

      yield* harness.engine.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("cmd-auto-settle-with-session"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: beforeSettlement.snapshotSequence,
        settledAt: now,
      });

      yield* Deferred.await(sessionStopped);
      yield* Effect.promise(() => harness.drain());
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.settledOverride).toBe("settled");
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    }),
  );

  effectIt.effect("keeps a guarded session when background work starts before provider stop", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          deferReactorStart: true,
          serverActivation: Deferred.await(activation),
        }),
      );
      yield* Effect.promise(() => harness.startReactor());
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-guarded-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const snapshotSequence = yield* harness.engine.latestSequence;
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-guarded-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
        onlyIfIdle: true,
        snapshotSequence,
        expectedProviderName: ProviderDriverKind.make("codex"),
        expectedProviderSessionId: "session-1",
      });

      harness.backgroundLiveness.recordTaskLiveness({
        threadId: "thread-1",
        taskId: "background-agent-1",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      yield* Deferred.succeed(activation, undefined);
      yield* Effect.promise(() => harness.drain());

      expect(harness.stopSession).not.toHaveBeenCalled();
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("ready");
    }),
  );

  effectIt.effect("keeps the projection active when an exact guarded stop is rejected", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ stopSessionIfCurrentEffect: () => Effect.succeed(false) }),
      );
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-1");

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-rejected-guarded-stop"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const snapshotSequence = yield* harness.engine.latestSequence;
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-rejected-guarded-session-stop"),
        threadId,
        createdAt: now,
        onlyIfIdle: true,
        snapshotSequence,
        expectedProviderName: ProviderDriverKind.make("codex"),
        expectedProviderSessionId: "session-1",
      });

      yield* Effect.promise(() => harness.drain());

      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.stopSessionIfCurrent).toHaveBeenCalledWith({
        threadId,
        expectedProviderName: ProviderDriverKind.make("codex"),
        expectedProviderSessionId: "session-1",
      });
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      expect(thread?.session?.status).toBe("ready");
    }),
  );

  effectIt.effect("does not project stopped over a replacement session", () =>
    Effect.gen(function* () {
      let installReplacement: Effect.Effect<void> = Effect.void;
      const harness = yield* Effect.promise(() =>
        createHarness({
          stopSessionIfCurrentEffect: () => installReplacement.pipe(Effect.as(true)),
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-1");

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-before-replacement-race"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      installReplacement = harness.engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-install-replacement-during-stop"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerSessionId: "session-2",
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        })
        .pipe(Effect.orDie);
      const snapshotSequence = yield* harness.engine.latestSequence;

      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-guarded-stop-with-replacement-race"),
        threadId,
        createdAt: now,
        onlyIfIdle: true,
        snapshotSequence,
        expectedProviderName: ProviderDriverKind.make("codex"),
        expectedProviderSessionId: "session-1",
      });
      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.session?.status).toBe("ready");
      expect(thread?.session?.providerSessionId).toBe("session-2");
    }),
  );

  effectIt.effect("keeps a guarded session when the thread changes before provider stop", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          deferReactorStart: true,
          serverActivation: Deferred.await(activation),
        }),
      );
      yield* Effect.promise(() => harness.startReactor());
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-before-thread-change"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      const snapshotSequence = yield* harness.engine.latestSequence;
      yield* harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-guarded-stop-before-thread-change"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
        onlyIfIdle: true,
        snapshotSequence,
        expectedProviderName: ProviderDriverKind.make("codex"),
        expectedProviderSessionId: "session-1",
      });
      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-change-after-guarded-stop"),
        threadId: ThreadId.make("thread-1"),
        title: "Re-engaged thread",
      });

      yield* Deferred.succeed(activation, undefined);
      yield* Effect.promise(() => harness.drain());

      expect(harness.stopSession).not.toHaveBeenCalled();
      const readModel = yield* Effect.promise(() => harness.readModel());
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("ready");
    }),
  );

  // The incident: a queued turn start was still inside its (slow) session start
  // when pending-turn reconciliation found it unclaimed, replayed it, and
  // restarted the session underneath it. The command's createdAt is the
  // client's queue time, so reconciliation treats it as stuck at once.
  it("does not let reconciliation replay a turn start that is still starting its session", async () => {
    const threadId = ThreadId.make("thread-1");
    // Assigned before the first start can run: nothing starts until the dispatch below.
    let firstStartGate: Deferred.Deferred<void> | undefined;
    let startCalls = 0;
    const harness = await createHarness({
      startSessionEffect: (session) => {
        startCalls += 1;
        return startCalls === 1 && firstStartGate !== undefined
          ? Deferred.await(firstStartGate).pipe(Effect.as(session))
          : Effect.succeed(session);
      },
    });
    firstStartGate = await harness.runEffect(Deferred.make<void>());

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-queued-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("message-queued-while-switching"),
          role: "user",
          text: "continue on the personal account",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    // Runs to completion while the first start is still parked.
    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.runEffect(Deferred.succeed(firstStartGate, undefined));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("defers a session restart until the provider's running turn ends", async () => {
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-running"),
        threadId,
        message: {
          messageId: asMessageId("message-running"),
          role: "user",
          text: "long task",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const running = harness.runtimeSessions.find((session) => session.threadId === threadId);
    expect(running).toBeDefined();
    harness.runtimeSessions.splice(harness.runtimeSessions.indexOf(running!), 1, {
      ...running!,
      status: "running",
      activeTurnId: asTurnId("turn-1"),
    });
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-turn-running-admitted"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    // A runtime-mode change needs a restart; mid-turn it must wait.
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-mid-turn"),
        threadId,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).not.toHaveBeenCalled();
  });
  it("classifies a turn-start failure afresh instead of keeping the previous turn's reason", async () => {
    const threadId = ThreadId.make("thread-1");
    const now = "2026-09-21T01:40:00.000Z";
    const harness = await createHarness({
      startSessionEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/start",
            detail: "401 Unauthorized: please log in to Codex again.",
          }),
        ),
    });
    const usageLimit = {
      kind: "usage_limit" as const,
      message: "Codex usage limit reached.",
      resetsAt: "2026-09-21T01:42:00.000Z",
    };
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-previous-usage-limit"),
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: usageLimit.message,
          lastErrorReason: usageLimit,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-after-limit"),
        threadId,
        message: {
          messageId: asMessageId("message-after-limit"),
          role: "user",
          text: "try again",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const session = (await harness.readModel()).threads[0]?.session;
      return session?.lastError === "401 Unauthorized: please log in to Codex again.";
    });
    const session = (await harness.readModel()).threads[0]?.session;
    expect(session?.lastErrorReason).toMatchObject({
      kind: "auth",
      message: "401 Unauthorized: please log in to Codex again.",
    });
  });

  it("holds a turn that needs another account until the running turn ends, then runs it there", async () => {
    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const personal = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5-codex",
    };
    const harness = await createHarness();
    const turnStart = (id: string, text: string, modelSelection?: ModelSelection) =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-${id}`),
          threadId,
          message: { messageId: asMessageId(`message-${id}`), role: "user", text, attachments: [] },
          ...(modelSelection ? { modelSelection, expectedModelSelection: modelSelection } : {}),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
    const setProviderTurn = (activeTurnId: TurnId | undefined) => {
      const index = harness.runtimeSessions.findIndex((entry) => entry.threadId === threadId);
      const { activeTurnId: _previous, ...session } = harness.runtimeSessions[index]!;
      harness.runtimeSessions.splice(index, 1, {
        ...session,
        status: activeTurnId ? "running" : "ready",
        ...(activeTurnId ? { activeTurnId } : {}),
      });
    };
    const threadSession = (status: "running" | "ready") =>
      harness.runEffect(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-first-turn-${status}`),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: status === "running" ? asTurnId("turn-1") : null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

    await turnStart("first", "long task");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    setProviderTurn(asTurnId("turn-1"));
    await threadSession("running");

    // The user switches account and sends while the first turn still runs.
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-switch-to-personal"),
        threadId,
        modelSelection: personal,
      }),
    );
    await turnStart("second", "continue on personal", personal);
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    const kinds = (await harness.readModel()).threads[0]?.activities.map((a) => a.kind) ?? [];
    expect(kinds).not.toContain("provider.turn.start.failed");

    // The first turn ends; the held turn now runs on the account it asked for.
    setProviderTurn(undefined);
    await threadSession("ready");
    await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerInstanceId: personal.instanceId,
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({ input: "continue on personal" });
  });

  describe("resume fallback", () => {
    const personal = ProviderInstanceId.make("claude-personal");
    const work = ProviderInstanceId.make("claude-work");

    /** Runs and settles one turn so the thread has history and a live session. */
    async function withSettledFirstTurn(
      harness: Awaited<ReturnType<typeof createHarness>>,
      bound: { readonly providerName: string; readonly providerInstanceId: ProviderInstanceId },
    ) {
      const threadId = ThreadId.make("thread-1");
      const now = "2026-09-21T01:30:00.000Z";
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-first-turn"),
          threadId,
          message: {
            messageId: asMessageId("message-first"),
            role: "user",
            text: "first question about the orchard",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const session = (status: "running" | "ready") => ({
        threadId,
        status,
        ...bound,
        runtimeMode: "approval-required" as const,
        activeTurnId: status === "running" ? asTurnId("turn-1") : null,
        lastError: null,
        updatedAt: now,
      });
      for (const status of ["running", "ready"] as const) {
        await harness.runEffect(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-first-turn-${status}`),
            threadId,
            session: session(status),
            createdAt: now,
          }),
        );
      }
    }

    const secondTurn = (modelSelection: ModelSelection) =>
      ({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-second-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-second"),
          role: "user",
          text: "second question",
          attachments: [],
        },
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-09-21T01:44:21.000Z",
      }) as const;

    const carriedOverInput = (harness: Awaited<ReturnType<typeof createHarness>>) =>
      String((harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined)?.input);

    async function activityKinds(harness: Awaited<ReturnType<typeof createHarness>>) {
      const thread = (await harness.readModel()).threads[0];
      return thread?.activities.map((activity) => activity.kind) ?? [];
    }

    it("starts fresh with the conversation when the new account cannot resume the old one", async () => {
      const harness = await createHarness({
        threadModelSelection: { instanceId: personal, model: "claude-sonnet-5" },
      });
      await withSettledFirstTurn(harness, {
        providerName: "claudeAgent",
        providerInstanceId: personal,
      });

      await harness.runEffect(
        harness.engine.dispatch(secondTurn({ instanceId: work, model: "claude-sonnet-5" })),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      const restart = harness.startSession.mock.calls[1];
      expect(restart?.[1]).toMatchObject({ providerInstanceId: work });
      expect(restart?.[1]).not.toHaveProperty("resumeCursor");
      // The mock is typed with two parameters; the start options ride third.
      expect((restart as ReadonlyArray<unknown> | undefined)?.[2]).toEqual({
        allowIncompatibleUnstartedReplacement: true,
      });
      expect(carriedOverInput(harness)).toContain(
        "This conversation moved to a new provider session",
      );
      expect(carriedOverInput(harness)).toContain("first question about the orchard");
      expect(carriedOverInput(harness)).toMatch(/second question$/);
      const kinds = await activityKinds(harness);
      expect(kinds).toContain("provider.session.carried-over");
      expect(kinds).not.toContain("provider.turn.start.failed");
    });

    it("carries the conversation over when the provider quietly declines a resume", async () => {
      let starts = 0;
      const harness = await createHarness({
        startSessionEffect: (session) =>
          Effect.succeed(
            (starts += 1) === 2 ? { ...session, resumeDeclined: true as const } : session,
          ),
      });
      await withSettledFirstTurn(harness, {
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
      });

      await harness.runEffect(
        harness.engine.dispatch(
          secondTurn({
            instanceId: ProviderInstanceId.make("codex_personal"),
            model: "gpt-5-codex",
          }),
        ),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.startSession.mock.calls[1]?.[1]).toHaveProperty("resumeCursor");
      expect(carriedOverInput(harness)).toContain("first question about the orchard");
      expect(await activityKinds(harness)).toContain("provider.session.carried-over");
    });

    it("retries fresh when the provider rejects the resume cursor", async () => {
      let starts = 0;
      const harness = await createHarness({
        startSessionEffect: (session) =>
          (starts += 1) === 2
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread/resume",
                  detail: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
                }),
              )
            : Effect.succeed(session),
      });
      await withSettledFirstTurn(harness, {
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
      });

      await harness.runEffect(
        harness.engine.dispatch(
          secondTurn({
            instanceId: ProviderInstanceId.make("codex_personal"),
            model: "gpt-5-codex",
          }),
        ),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);

      expect(harness.startSession).toHaveBeenCalledTimes(3);
      expect(harness.startSession.mock.calls[1]?.[1]).toHaveProperty("resumeCursor");
      expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("resumeCursor");
      expect(carriedOverInput(harness)).toContain("first question about the orchard");
      expect(await activityKinds(harness)).toContain("provider.session.carried-over");
    });

    // A restart between the carry-over and the next send empties the reactor's
    // memory. The state is written before the reactor starts, as after a
    // restart, so only the persisted notice can bring the conversation along.
    it.each([
      [
        "imports history after a restart while the carried-over turn is still the latest",
        "turn-1",
        true,
      ],
      ["does not import again once a turn has run since the carry-over", "turn-0", false],
    ] as const)("%s", async (_name, afterTurnId, imports) => {
      const threadId = ThreadId.make("thread-1");
      const now = "2026-09-21T01:30:00.000Z";
      const harness = await createHarness({ deferReactorStart: true });
      const run = (command: Parameters<typeof harness.engine.dispatch>[0]) =>
        harness.runEffect(harness.engine.dispatch(command));
      {
        await run({
          type: "thread.message.user.append",
          commandId: CommandId.make("cmd-history-message"),
          threadId,
          message: {
            messageId: asMessageId("message-history"),
            text: "first question about the orchard",
            attachments: [],
          },
          createdAt: now,
        });
        for (const status of ["running", "ready"] as const) {
          await run({
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-history-turn-${status}`),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: status === "running" ? asTurnId("turn-1") : null,
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
        await run({
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-carried-over-before-restart"),
          threadId,
          activity: {
            id: EventId.make("activity-carried-over"),
            tone: "info",
            kind: "provider.session.carried-over",
            summary: "Continued in a new codex session",
            payload: {
              threadId,
              providerInstanceId: "codex",
              reason: "resume-declined",
              afterTurnId,
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
      }
      await harness.startReactor();

      await harness.runEffect(
        harness.engine.dispatch(
          secondTurn({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" }),
        ),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const input = String(
        (harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined)?.input,
      );
      expect(input.includes("first question about the orchard")).toBe(imports);
    });

    // The server died after the provider admitted the carried-over turn: the
    // restored marker must clear when reconciliation finds that admission.
    it("does not import again after a restart once the carried-over turn was admitted", async () => {
      const threadId = ThreadId.make("thread-1");
      const admittedMessageId = MessageId.make("message-carried-and-admitted");
      const then = "2025-12-31T23:59:00.000Z";
      const harness = await createHarness({ deferReactorStart: true });
      const run = (command: Parameters<typeof harness.engine.dispatch>[0]) =>
        harness.runEffect(harness.engine.dispatch(command));
      await run({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-carried-and-admitted"),
        threadId,
        message: {
          messageId: admittedMessageId,
          role: "user",
          text: "first question about the orchard",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: then,
      });
      await run({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-carried-and-admitted-starting"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: then,
        },
        createdAt: then,
      });
      await run({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-carried-and-admitted-notice"),
        threadId,
        activity: {
          id: EventId.make("activity-carried-and-admitted"),
          tone: "info",
          kind: "provider.session.carried-over",
          summary: "Continued in a new codex session",
          payload: {
            threadId,
            providerInstanceId: "codex",
            reason: "resume-declined",
            afterTurnId: null,
          },
          turnId: null,
          createdAt: then,
        },
        createdAt: then,
      });
      await harness.runEffect(
        harness.directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          runtimePayload: {
            activeTurnId: null,
            lastAdmittedMessageId: admittedMessageId,
            lastAdmittedTurnId: TurnId.make("turn-carried-and-admitted"),
          },
        }),
      );
      await harness.startReactor();
      await harness.runEffect(harness.reactor.reconcilePendingTurns(threadId));
      await harness.drain();

      await harness.runEffect(
        harness.engine.dispatch(
          secondTurn({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" }),
        ),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "second question" });
    });

    it("does not abandon a resumable session over a failure that is not a resume", async () => {
      let starts = 0;
      const harness = await createHarness({
        startSessionEffect: (session) =>
          (starts += 1) === 2
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread/resume",
                  detail:
                    "Codex usage limit reached. Send the message again once the limit resets.",
                }),
              )
            : Effect.succeed(session),
      });
      await withSettledFirstTurn(harness, {
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
      });

      await harness.runEffect(
        harness.engine.dispatch(
          secondTurn({
            instanceId: ProviderInstanceId.make("codex_personal"),
            model: "gpt-5-codex",
          }),
        ),
      );
      await waitFor(async () =>
        (await activityKinds(harness)).includes("provider.turn.start.failed"),
      );

      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(await activityKinds(harness)).not.toContain("provider.session.carried-over");
    });
  });
});
