import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2Shape,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:routing");
const instances = ["codex-a", "codex-b", "codex-c"].map((instanceId) =>
  ProviderInstanceId.make(instanceId),
);
const adapter = (instanceId: ProviderInstanceId): ProviderAdapterV2Shape => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Routing control tests never open a provider process"),
});
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
const providers = instances.map((instanceId, index) =>
  decodeServerProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    continuation: { groupKey: "codex:home:shared" },
    models: [{ slug: "gpt-5.1-codex", name: "Codex", isCustom: false, capabilities: null }],
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 1_000)),
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          usedPercent: 10 + index,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + (index + 1) * 86_400_000)),
        },
      ],
    },
  }),
);
const layerDatabase = SqlitePersistence.layerMemory;
const testLayer = (consented = true, adapters = instances.map(adapter)) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "account-routing" },
      ProviderAdapterRegistry.layerFromAdapters(adapters),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        serverSettings: consented
          ? {
              projectSettingsOverrides: {
                [projectId]: {
                  providerRoutingPolicy: {
                    defaultMode: "auto",
                    usageThresholdPercent: 90,
                    instanceIdsByDriver: { [ProviderDriverKind.make("codex")]: instances },
                  },
                },
              },
            }
          : {},
        routingProvidersLayer: Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers),
        }),
      },
    ),
  );
const seed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Routing",
      modelSelection: { instanceId: instances[0]!, model: "gpt-5.1-codex" },
      providerRoutingMode: "auto",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Original request",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
      allowProviderAccountRouting: true,
    });
  });
const failAndRetry = (threadId: ThreadId, failureClass: "provider_error" | "usage_limit") =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const before = yield* projectionStore.getThreadProjection(threadId);
    const run = before.runs.at(-1)!;
    const now = yield* DateTime.now;
    const base = {
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
    };
    yield* projectionStore.apply({
      ...base,
      id: EventId.make(`failure:${run.id}`),
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`failure:${run.id}`),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: run.ordinal * 100 + 1,
        status: "failed",
        title: "Rejected",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error",
        failure: makeProviderFailure({ class: failureClass, message: "Rejected" }),
      },
    });
    yield* projectionStore.apply({
      ...base,
      id: EventId.make(`failed:${run.id}`),
      type: "run.updated",
      payload: { ...run, status: "failed", completedAt: now },
    });
    const command = {
      type: "provider-account.route.retry" as const,
      commandId: CommandId.make(`retry:${run.id}`),
      threadId,
      runId: run.id,
    };
    yield* orchestrator.dispatch(command);
    yield* orchestrator.dispatch(command);
    return yield* projectionStore.getThreadProjection(threadId);
  });

it.effect(
  "tries the next consented account after startup failure and usage rejection without duplicating input",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:routing-fallback");
      yield* seed(threadId);
      let projection = yield* failAndRetry(threadId, "provider_error");
      assert.equal(projection.runs.length, 2);
      assert.equal(projection.runs.at(-1)?.providerInstanceId, instances[1]);
      projection = yield* failAndRetry(threadId, "usage_limit");
      assert.equal(projection.runs.length, 3);
      assert.equal(projection.runs.at(-1)?.providerInstanceId, instances[2]);
      projection = yield* failAndRetry(threadId, "usage_limit");
      assert.equal(projection.runs.length, 3);
      assert.equal(projection.messages.filter((message) => message.role === "user").length, 1);
      assert.equal(projection.turnItems.filter((item) => item.type === "user_message").length, 1);
      assert.equal(projection.messages[0]?.text, "Original request");
    }).pipe(Effect.provide(testLayer())),
);
it.effect("never authorizes runtime fallback from server-wide defaults", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:routing-no-consent");
    yield* seed(threadId);
    const projection = yield* failAndRetry(threadId, "usage_limit");
    assert.equal(projection.runs.length, 1);
    assert.equal(projection.thread.providerInstanceId, instances[0]);
  }).pipe(Effect.provide(testLayer(false))),
);

const failingOpenCalls: ProviderInstanceId[] = [];
const failingAdapters = instances.map((instanceId): ProviderAdapterV2Shape => ({
  ...adapter(instanceId),
  openSession: ({ providerSessionId }) =>
    Effect.gen(function* () {
      failingOpenCalls.push(instanceId);
      return yield* new ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("codex"),
        providerSessionId,
        cause: "Mock account startup failed",
      });
    }),
}));
it.effect("routes actual provider-session startup failures through the same original input", () =>
  Effect.gen(function* () {
    failingOpenCalls.length = 0;
    const threadId = ThreadId.make("thread:routing-real-start");
    yield* seed(threadId);
    const start = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const instanceId of instances) {
      const run = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
      assert.equal(run.providerInstanceId, instanceId);
      yield* start.start({ threadId, runId: run.id, willRetry: false });
      yield* orchestrator.dispatch({
        type: "provider-account.route.retry",
        threadId,
        runId: run.id,
        commandId: CommandId.make(`command:provider-account-route-retry:${run.id}`),
      });
    }
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(failingOpenCalls, instances);
    assert.equal(projection.runs.length, 3);
    assert.equal(projection.runs.at(-1)?.status, "failed");
    assert.equal(projection.messages.filter((message) => message.role === "user").length, 1);
  }).pipe(Effect.provide(testLayer(true, failingAdapters))),
);

it.effect("honors project routing defaults on the direct thread.create path", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:routing-default");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:routing-default"),
      threadId,
      projectId,
      title: "Routing default",
      modelSelection: { instanceId: instances[0]!, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).thread.providerRoutingMode,
      "auto",
    );
  }).pipe(Effect.provide(testLayer())),
);
