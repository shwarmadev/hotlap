import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { hotlapLimitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const instanceId = ProviderInstanceId.make("claude-recovery");
const driver = ProviderDriverKind.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Recovery admission needs no provider process"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "hotlap-limit-recovery" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const seed = Effect.fn(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("recovery-thread");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("recovery-project"),
    title: "Recovery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});
const fail = Effect.fn(function* (
  threadId: ThreadId,
  ordinal = 1,
  synthetic = false,
  resetAt?: string,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const existing = (yield* store.getThreadProjection(threadId)).runs.find(
    (run) => run.ordinal === ordinal,
  );
  const runId = existing?.id ?? RunId.make(`run-${ordinal}`);
  const nodeId = existing?.rootNodeId ?? NodeId.make(`node-${ordinal}`);
  const run = {
    id: runId,
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`${synthetic ? "hotlap-limit-resume:" : "user:"}${ordinal}`),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "failed" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`run-${ordinal}`),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: run,
  });
  const base = {
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "failed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  yield* store.apply({
    id: EventId.make(`user-item-${ordinal}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      ...base,
      id: TurnItemId.make(`user-item-${ordinal}`),
      ordinal: ordinal * 10,
      type: "user_message",
      createdBy: "user",
      creationSource: "server",
      messageId: run.userMessageId,
      inputIntent: "turn_start",
      text: "Continue",
      attachments: [],
    },
  });
  yield* store.apply({
    id: EventId.make(`error-${ordinal}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      ...base,
      id: TurnItemId.make(`error-${ordinal}`),
      ordinal: ordinal * 10 + 1,
      type: "error",
      failure: {
        class: "usage_limit",
        message: "Usage limit",
        ...(resetAt === undefined ? {} : { resetAt }),
        code: null,
        retryable: null,
      },
    },
  });
  return run;
});
const planned = Effect.fn(function* (enabled = true) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const rows = yield* store.getLimitRecoveryCandidates({
    now,
    autoResume: false,
    snooze: false,
    hotlapAutoResume: enabled,
  });
  assert.equal(rows.length, 1);
  return hotlapLimitRecoveryCommand(rows[0]!, enabled, true, DateTime.toEpochMillis(now));
});
const dispatch = Effect.fn(function* (command: OrchestrationV2Command | null) {
  assert.ok(command);
  yield* (yield* Orchestrator.OrchestratorV2).dispatch(command);
});

it.effect(
  "persists unknown-reset budget, survives reads and retains it after a hidden retry failure",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* dispatch(yield* planned());
      const cycle = (yield* store.getThread(threadId)).limitRecovery?.hotlapCycle;
      assert.ok(cycle);
      assert.equal(cycle.deadlineAtMs - cycle.startedAtMs, 6 * 60 * 60_000);
      const sqlClient = yield* SqlClient.SqlClient;
      const restarted = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(
          Layer.fresh(ProjectionStore.layer).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sqlClient)),
          ),
        ),
      );
      assert.deepEqual((yield* restarted.getThread(threadId)).limitRecovery?.hotlapCycle, cycle);
      assert.equal(yield* planned(), null);
      yield* TestClock.adjust("5 minutes");
      const retry = yield* planned();
      assert.equal(retry?.type, "message.dispatch");
      yield* dispatch(retry);
      // A repeated scheduler delivery is receipt-idempotent.
      yield* dispatch(retry);
      assert.equal((yield* store.getThreadProjection(threadId)).runs.length, 2);
      yield* fail(threadId, 2, true);
      const candidate = (yield* store.getLimitRecoveryCandidates({
        now: yield* DateTime.now,
        autoResume: false,
        snooze: false,
        hotlapAutoResume: true,
      }))[0]!;
      assert.equal(candidate.latestRunMessageId, "hotlap-limit-resume:2");
      yield* dispatch(yield* planned());
      const rearmed = (yield* store.getThread(threadId)).limitRecovery?.hotlapCycle;
      assert.equal(rearmed?.startedAtMs, cycle.startedAtMs);
      assert.equal(rearmed?.deadlineAtMs, cycle.deadlineAtMs);
      assert.equal(rearmed?.nextAttemptAtMs, cycle.nextAttemptAtMs + 5 * 60_000);
      yield* TestClock.adjust("6 hours");
      yield* dispatch(yield* planned());
      assert.equal((yield* store.getThread(threadId)).limitRecovery?.autoResume, false);
      assert.equal(yield* planned(), null);
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("rejects delayed retry after cancellation and foreground queue creation", () =>
  Effect.gen(function* () {
    const threadId = yield* seed();
    yield* fail(threadId);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* dispatch(yield* planned());
    yield* TestClock.adjust("5 minutes");
    const retry = yield* planned();
    const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("queued-foreground"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        ...original,
        id: RunId.make("queued-foreground"),
        ordinal: 2,
        userMessageId: MessageId.make("foreground"),
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
      },
    });
    const before = yield* store.getThreadProjection(threadId);
    yield* dispatch(retry);
    assert.equal((yield* store.getThreadProjection(threadId)).runs.length, before.runs.length);
    const recovery = (yield* store.getThread(threadId)).limitRecovery;
    assert.ok(recovery);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("cancel"),
      threadId,
      limitRecovery: { ...recovery, autoResume: false },
    });
    assert.equal(yield* planned(), null);
  }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect(
  "SQL timeline pages hide retry prompts and retry limit errors while retaining original failure",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId);
      yield* TestClock.adjust("1 minute");
      yield* fail(threadId, 2, true);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const page = yield* store.getTimelinePage(threadId, { view: "activity", limit: 50 });
      assert.deepEqual(
        page.items.map((row) => row.item.id),
        ["user-item-1", "error-1"],
      );
      assert.equal(page.totalItems, 2);
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect(
  "allows cancellation during an admitted background retry and clears a new foreground choice",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* dispatch(yield* planned());
      yield* TestClock.adjust("5 minutes");
      yield* dispatch(yield* planned());
      const recovery = (yield* store.getThread(threadId)).limitRecovery;
      assert.ok(recovery);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cancel-running"),
        threadId,
        // Web/mobile choice updates omit the cycle; the server retains it.
        limitRecovery: {
          runId: recovery.runId,
          resetAt: recovery.resetAt,
          autoResume: false,
        },
      });
      assert.equal((yield* store.getThread(threadId)).limitRecovery?.autoResume, false);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("foreground-new"),
        messageId: MessageId.make("foreground-new"),
        threadId,
        text: "New task",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal((yield* store.getThread(threadId)).limitRecovery, null);
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each(["completed", "interrupted", "cancelled", "nonusage"] as const)(
  "durably closes the recovery cycle when the retry ends %s",
  (outcome) =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* dispatch(yield* planned());
      yield* TestClock.adjust("5 minutes");
      yield* dispatch(yield* planned());
      const retry = (yield* store.getThreadProjection(threadId)).runs.find(
        (run) => run.ordinal === 2,
      )!;
      const now = yield* DateTime.now;
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`terminal-${outcome}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...retry,
              status: outcome === "nonusage" ? "failed" : outcome,
              completedAt: now,
            },
          },
        ],
      });
      // Drain the in-process terminal event subscriber; no provider/network runs.
      for (let index = 0; index < 200; index++) {
        yield* Effect.yieldNow;
        if ((yield* store.getThread(threadId)).limitRecovery === null) break;
      }
      assert.equal((yield* store.getThread(threadId)).limitRecovery, null);
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect(
  "replay memory and SQL candidates agree for persisted unknown-reset hidden failures",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId, 1, true);
      yield* dispatch(yield* planned());
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* store.getThreadProjection(threadId);
      const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layerMemory),
      );
      const now = yield* DateTime.now;
      yield* memory.apply({
        id: EventId.make("memory-thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: projection.thread,
      });
      for (const run of projection.runs)
        yield* memory.apply({
          id: EventId.make(`memory-${run.id}`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: run,
        });
      for (const item of projection.turnItems)
        yield* memory.apply({
          id: EventId.make(`memory-${item.id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: item,
        });
      const options = { now, autoResume: false, snooze: false, hotlapAutoResume: true };
      const sql = yield* store.getLimitRecoveryCandidates(options);
      const replay = yield* memory.getLimitRecoveryCandidates(options);
      assert.equal(replay.length, sql.length);
      assert.deepEqual(
        replay.map((row) =>
          Object.fromEntries(Object.keys(sql[0]!).map((key) => [key, Reflect.get(row, key)])),
        ),
        [...sql],
      );
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("a pending provider question blocks a previously planned retry", () =>
  Effect.gen(function* () {
    const threadId = yield* seed();
    yield* fail(threadId);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* dispatch(yield* planned());
    yield* TestClock.adjust("5 minutes");
    const retry = yield* planned();
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("pending-question"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("pending-question"),
        nodeId: NodeId.make("question-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    assert.equal(
      (yield* store.getLimitRecoveryCandidates({
        now,
        autoResume: false,
        snooze: false,
        hotlapAutoResume: true,
      })).length,
      0,
    );
    yield* dispatch(retry);
    assert.equal((yield* store.getThreadProjection(threadId)).runs.length, 1);
  }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("stops an existing cycle after a provider switch without repeated rejected updates", () =>
  Effect.gen(function* () {
    const threadId = yield* seed();
    yield* fail(threadId);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* dispatch(yield* planned());
    const thread = yield* store.getThread(threadId);
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("provider-switch"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...thread, providerInstanceId: ProviderInstanceId.make("other-provider") },
    });
    const [candidate] = yield* store.getLimitRecoveryCandidates({
      now,
      autoResume: false,
      snooze: false,
      hotlapAutoResume: true,
    });
    assert.ok(candidate);
    yield* dispatch(
      hotlapLimitRecoveryCommand(candidate, true, false, DateTime.toEpochMillis(now)),
    );
    assert.equal((yield* store.getThread(threadId)).limitRecovery?.autoResume, false);
  }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("persists the reset grace schedule and its bounded deadline", () =>
  Effect.gen(function* () {
    const threadId = yield* seed();
    const now = yield* DateTime.now;
    yield* fail(threadId, 1, false, DateTime.formatIso(DateTime.add(now, { minutes: 2 })));
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* dispatch(yield* planned());
    const cycle = (yield* store.getThread(threadId)).limitRecovery?.hotlapCycle;
    assert.ok(cycle);
    assert.equal(cycle.nextAttemptAtMs, DateTime.toEpochMillis(now) + 3 * 60_000);
    assert.equal(cycle.deadlineAtMs, DateTime.toEpochMillis(now) + 32 * 60_000);
    yield* TestClock.adjust("2 minutes");
    assert.equal(yield* planned(), null);
    yield* TestClock.adjust("30 minutes");
    yield* dispatch(yield* planned());
    assert.equal((yield* store.getThread(threadId)).limitRecovery?.autoResume, false);
  }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each(["assistant", "tool"] as const)(
  "real %s progress closes the old budget before a later limit starts a fresh cycle",
  (kind) =>
    Effect.gen(function* () {
      const threadId = yield* seed();
      yield* fail(threadId);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* dispatch(yield* planned());
      const originalCycle = (yield* store.getThread(threadId)).limitRecovery?.hotlapCycle;
      yield* TestClock.adjust("5 minutes");
      yield* dispatch(yield* planned());
      const retry = (yield* store.getThreadProjection(threadId)).runs.find(
        (run) => run.ordinal === 2,
      )!;
      const now = yield* DateTime.now;
      const base = {
        id: TurnItemId.make("genuine-progress"),
        threadId,
        runId: retry.id,
        nodeId: retry.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const sink = yield* EventSink.EventSinkV2;
      if (kind === "assistant") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("empty-progress"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...base,
                type: "assistant_message",
                messageId: MessageId.make("assistant-progress"),
                text: "",
                streaming: true,
              },
            },
          ],
        });
        for (let index = 0; index < 30; index++) yield* Effect.yieldNow;
        assert.ok((yield* store.getThread(threadId)).limitRecovery?.hotlapCycle);
      }
      yield* sink.write({
        events: [
          {
            id: EventId.make("real-progress"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload:
              kind === "assistant"
                ? {
                    ...base,
                    type: "assistant_message",
                    messageId: MessageId.make("assistant-progress"),
                    text: "I can continue now.",
                    streaming: true,
                  }
                : { ...base, type: "command_execution", input: "ls" },
          },
        ],
      });
      for (let index = 0; index < 200; index++) {
        yield* Effect.yieldNow;
        if ((yield* store.getThread(threadId)).limitRecovery === null) break;
      }
      assert.equal((yield* store.getThread(threadId)).limitRecovery, null);
      yield* TestClock.adjust("1 minute");
      yield* fail(threadId, 2, true);
      yield* dispatch(yield* planned());
      const fresh = (yield* store.getThread(threadId)).limitRecovery?.hotlapCycle;
      assert.ok(fresh);
      assert.equal(fresh.startedAtMs, DateTime.toEpochMillis(yield* DateTime.now));
      assert.notEqual(fresh.startedAtMs, originalCycle?.startedAtMs);
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);
