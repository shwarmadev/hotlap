import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Guarded stop tests never open a provider process"),
};
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guarded-stop" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const create = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("guarded-project"),
      title: "Idle",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    yield* events.write({
      events: [
        {
          type: "provider-session.attached",
          id: EventId.make(`attach:${threadId}`),
          threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/repo",
            model: "gpt-5.1-codex",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
      ],
    });
    return { providerSessionId, sequence: yield* events.latestSequence() };
  });

it.effect("rejects stale and future stop snapshots without projecting a detached session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("guarded-stale");
    const { providerSessionId, sequence } = yield* create(threadId);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const snapshotSequence of [0, sequence + 1]) {
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make(`stop:${snapshotSequence}`),
          threadId,
          providerSessionId,
          idleGuard: { snapshotSequence, expectedProviderName: adapter.driver },
        }),
      );
      assert.equal(exit._tag, "Failure");
      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["providerSessions"])).providerSessions[0]
          ?.status,
        "ready",
      );
    }
    yield* orchestrator.dispatch({
      type: "provider-session.detach",
      commandId: CommandId.make("valid-stop"),
      threadId,
      providerSessionId,
      idleGuard: { snapshotSequence: sequence, expectedProviderName: adapter.driver },
    });
    assert.equal(
      (yield* projections.getThreadRecords(threadId, ["providerSessions"])).providerSessions.length,
      0,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses an apparently idle provider session while workspace preparation is accepted",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("guarded-preparing");
      const { providerSessionId } = yield* create(threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("prepare-run"),
        threadId,
        messageId: MessageId.make("prepare-message"),
        text: "Prepare",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "defer_start" },
      });
      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]?.status,
        "preparing",
      );
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make("stop-preparing"),
          threadId,
          providerSessionId,
          idleGuard: {
            snapshotSequence: yield* events.latestSequence(),
            expectedProviderName: adapter.driver,
          },
        }),
      );
      assert.equal(exit._tag, "Failure");
      assert.equal(
        (yield* projections.getThreadRecords(threadId, ["providerSessions"])).providerSessions[0]
          ?.status,
        "ready",
      );
    }).pipe(Effect.provide(layerTest)),
);
