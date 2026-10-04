import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderStopSessionInput,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as UsageLimitAutoResumeReactor from "./UsageLimitAutoResumeReactor.ts";
import { UsageLimitWaitingThreads } from "./UsageLimitWaitingThreads.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-09-28T01:00:00.000Z");
const THREAD_ID = ThreadId.make("limited-thread");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");

type ActivityAppend = Extract<OrchestrationCommand, { readonly type: "thread.activity.append" }>;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project"),
    title: "Long task",
    modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: iso(START - HOUR),
    updatedAt: iso(START),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: THREAD_ID,
      status: "error",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Claude usage limit reached.",
      updatedAt: iso(START),
    },
    latestUserMessageAt: iso(START - HOUR),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

let eventCounter = 0;
const runtimeBase = (instanceId: ProviderInstanceId = CLAUDE) => ({
  eventId: EventId.make(`runtime-${++eventCounter}`),
  provider: ProviderDriverKind.make(instanceId === CLAUDE ? "claudeAgent" : "codex"),
  providerInstanceId: instanceId,
  threadId: THREAD_ID,
  createdAt: iso(START),
});

function usageLimitError(input: {
  readonly resetsAtMs?: number;
  readonly autoResume?: boolean;
  readonly instanceId?: ProviderInstanceId;
  readonly turnId?: string;
}): ProviderRuntimeEvent {
  return {
    ...runtimeBase(input.instanceId),
    type: "runtime.error",
    turnId: TurnId.make(input.turnId ?? "limited-turn"),
    payload: {
      message: "Claude usage limit reached.",
      class: "usage_limit",
      detail: {
        ...(input.resetsAtMs === undefined ? {} : { resetsAt: input.resetsAtMs }),
        ...(input.autoResume === true ? { autoResume: true } : {}),
      },
    },
  };
}

const turnStarted = (turnId: string): ProviderRuntimeEvent => ({
  ...runtimeBase(),
  type: "turn.started",
  turnId: TurnId.make(turnId),
  payload: {},
});

const turnCompleted = (turnId: string, state: "completed" | "failed"): ProviderRuntimeEvent => ({
  ...runtimeBase(),
  type: "turn.completed",
  turnId: TurnId.make(turnId),
  payload: { state },
});

const domainBase = {
  sequence: 2,
  eventId: EventId.make("domain-event"),
  aggregateKind: "thread" as const,
  aggregateId: THREAD_ID,
  occurredAt: iso(START),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

const userMessage: OrchestrationEvent = {
  ...domainBase,
  type: "thread.turn-start-requested",
  payload: {
    threadId: THREAD_ID,
    messageId: MessageId.make("user-message"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: iso(START),
  },
};

const stopRequested = (guarded: boolean): OrchestrationEvent => ({
  ...domainBase,
  type: "thread.session-stop-requested",
  payload: {
    threadId: THREAD_ID,
    createdAt: iso(START),
    ...(guarded
      ? {
          onlyIfIdle: true,
          expectedProviderName: ProviderDriverKind.make("claudeAgent"),
          expectedProviderSessionId: "session",
          snapshotSequence: 1,
        }
      : {}),
  },
});

const cancellingEvents: ReadonlyArray<OrchestrationEvent> = [
  {
    ...domainBase,
    type: "thread.turn-interrupt-requested",
    payload: { threadId: THREAD_ID, createdAt: iso(START) },
  },
  {
    ...domainBase,
    type: "thread.checkpoint-revert-requested",
    payload: { threadId: THREAD_ID, turnCount: 1, createdAt: iso(START) },
  },
  {
    ...domainBase,
    type: "thread.archived",
    payload: { threadId: THREAD_ID, archivedAt: iso(START), updatedAt: iso(START) },
  },
  {
    ...domainBase,
    type: "thread.settled",
    payload: { threadId: THREAD_ID, settledAt: iso(START), updatedAt: iso(START) },
  },
];

const instanceChanged = (instanceId: ProviderInstanceId): OrchestrationEvent => ({
  ...domainBase,
  type: "thread.meta-updated",
  payload: {
    threadId: THREAD_ID,
    modelSelection: { instanceId, model: "claude-opus-5-5" },
    updatedAt: iso(START),
  },
});

/** The account switcher resending a limited message to another account. */
const usageLimitResend: OrchestrationEvent = {
  ...userMessage,
  commandId: CommandId.make("server:usage-limit-resend:resend"),
};

const autoRoutedThread = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeThread({ providerRoutingMode: "auto", ...overrides });

const threadDeleted: OrchestrationEvent = {
  ...domainBase,
  type: "thread.deleted",
  payload: { threadId: THREAD_ID, deletedAt: iso(START) },
};

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell;
  readonly settings?: ServerSettings;
  readonly recordedRows?: ReadonlyArray<OrchestrationThreadActivity>;
}

const makeHarness = Effect.fn("makeUsageLimitAutoResumeHarness")(function* (
  options: HarnessOptions = {},
) {
  const activation = yield* Deferred.make<void>();
  const thread = yield* Ref.make(Option.some(options.thread ?? makeThread()));
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  // One entry per tick: the tick is the only reader of settings.
  const ticks = yield* Queue.unbounded<void>();
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const appends = yield* Ref.make<ReadonlyArray<ActivityAppend>>([]);
  const sends = yield* Ref.make<ReadonlyArray<ProviderSendTurnInput>>([]);
  const sendFails = yield* Ref.make(false);
  const stops = yield* Ref.make<ReadonlyArray<ProviderStopSessionInput>>([]);
  /** Number of upcoming thread reads that fail. */
  const threadReadFailures = yield* Ref.make(0);
  const waitingIds = new Set<string>();

  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings).pipe(Effect.tap(() => Queue.offer(ticks, undefined))),
    updateSettings: () => Effect.die(new Error("unused")),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Effect.gen(function* () {
          const failures = yield* Ref.getAndUpdate(threadReadFailures, (n) => Math.max(0, n - 1));
          if (failures > 0) {
            return yield* new PersistenceSqlError({ operation: "getThreadShellById" });
          }
          return yield* Ref.get(thread);
        }),
      listActivitiesByKind: () => Effect.succeed(options.recordedRows ?? []),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        command.type === "thread.activity.append"
          ? Ref.update(appends, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 }))
          : Effect.die(new Error(`Unexpected command: ${command.type}`)),
      subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(ProviderService)({
      streamEvents: Stream.fromQueue(runtimeEvents),
      stopSession: (input) => Ref.update(stops, (all) => [...all, input]),
      sendTurn: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sends, (all) => [...all, input]);
          if (yield* Ref.get(sendFails)) {
            return yield* new ProviderAdapterValidationError({
              provider: "claudeAgent",
              operation: "sendTurn",
              issue: "session is busy",
            });
          }
          return {
            threadId: input.threadId,
            turnId: TurnId.make(`attempt-${(yield* Ref.get(sends)).length}`),
          };
        }),
    }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(UsageLimitWaitingThreads, waitingIds),
  );

  return {
    activation,
    thread,
    settings,
    ticks,
    appends,
    sends,
    sendFails,
    stops,
    threadReadFailures,
    waitingIds,
    runtimeEvents,
    domainEvents,
    layer: UsageLimitAutoResumeReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const run = <A, E>(
  options: HarnessOptions,
  body: (
    harness: Harness,
    reactor: UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const harness = yield* makeHarness(options);
      return yield* Effect.gen(function* () {
        const reactor = yield* UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor;
        yield* reactor.start();
        yield* Deferred.succeed(harness.activation, undefined);
        // The first tick runs as soon as the reactor activates.
        yield* Queue.take(harness.ticks);
        yield* reactor.drain;
        return yield* body(harness, reactor);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

/** Moves the clock in 30 second tick steps and waits for each tick to finish. */
const advance = (
  harness: Harness,
  reactor: UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor["Service"],
  ms: number,
) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
      yield* Queue.clear(harness.ticks);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(harness.ticks);
      yield* reactor.drain;
    }
  });

const emit = (
  harness: Harness,
  reactor: UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor["Service"],
  event: ProviderRuntimeEvent,
) =>
  Effect.gen(function* () {
    yield* Queue.offer(harness.runtimeEvents, event);
    // The runtime stream feeds the worker asynchronously.
    yield* Effect.yieldNow;
    yield* reactor.drain;
  });

const publish = (
  harness: Harness,
  reactor: UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor["Service"],
  event: OrchestrationEvent,
) =>
  Effect.gen(function* () {
    yield* PubSub.publish(harness.domainEvents, event);
    yield* Effect.yieldNow;
    yield* reactor.drain;
  });

const rows = (harness: Harness) =>
  Ref.get(harness.appends).pipe(Effect.map((all) => all.map((command) => command.activity)));

const lastRow = (harness: Harness) => rows(harness).pipe(Effect.map((all) => all.at(-1)));

/** Turn id the mock gave the latest hidden attempt. */
const latestAttemptTurnId = (harness: Harness) =>
  Ref.get(harness.sends).pipe(Effect.map((all) => `attempt-${all.length}`));

/** The latest hidden attempt hit the limit again. */
const attemptLimited = (
  harness: Harness,
  reactor: UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor["Service"],
  resetsAtMs?: number,
) =>
  Effect.gen(function* () {
    const turnId = yield* latestAttemptTurnId(harness);
    yield* emit(
      harness,
      reactor,
      usageLimitError({
        autoResume: true,
        turnId,
        ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
      }),
    );
  });

describe("UsageLimitAutoResumeReactor", () => {
  it.effect("waits, then sends the hidden continue prompt every 5 minutes", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));

        const waiting = yield* lastRow(harness);
        assert.strictEqual(waiting?.kind, "usage-limit.auto-resume");
        assert.strictEqual(waiting?.tone, "info");
        assert.strictEqual(waiting?.summary, "Usage limit reached. Auto-resuming when it resets.");
        assert.deepStrictEqual(waiting?.payload, {
          threadId: THREAD_ID,
          instanceId: CLAUDE,
          state: "waiting",
          resetAt: iso(START + 2 * HOUR),
          deadlineAt: iso(START + 2 * HOUR + 30 * MINUTE),
        });

        yield* advance(harness, reactor, 4.5 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);

        yield* advance(harness, reactor, 30_000);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), [
          {
            threadId: THREAD_ID,
            input: "Continue where you left off.",
            interactionMode: "plan",
            autoResume: true,
          },
        ]);

        yield* attemptLimited(harness, reactor);
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);
        // Failed attempts leave the row alone.
        assert.strictEqual((yield* rows(harness)).length, 1);
      }),
    ),
  );

  it.effect("marks the same row resumed once an attempt gets past the limit", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        yield* emit(harness, reactor, turnStarted("attempt"));

        const [waiting, resumed] = yield* rows(harness);
        assert.strictEqual(resumed?.summary, "Auto-resumed after usage limit");
        assert.strictEqual(resumed?.id, waiting?.id);
        assert.strictEqual(resumed?.createdAt, waiting?.createdAt);
        assert.propertyVal(resumed?.payload, "state", "resumed");

        yield* advance(harness, reactor, 15 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
      }),
    ),
  );

  it.effect("tries a minute after the reset when that comes before the next interval", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 7 * MINUTE }));
        yield* advance(harness, reactor, 5 * MINUTE);
        yield* attemptLimited(harness, reactor);

        yield* advance(harness, reactor, 2.5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
        yield* advance(harness, reactor, 30_000);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);
      }),
    ),
  );

  it.effect("a later reset from a swapped-in account extends the wait", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 10 * MINUTE }));
        yield* advance(harness, reactor, 5 * MINUTE);
        yield* attemptLimited(harness, reactor, START + 3 * HOUR);
        const [first, extended] = yield* rows(harness);
        assert.strictEqual(extended?.id, first?.id);
        assert.propertyVal(extended?.payload, "resetAt", iso(START + 3 * HOUR));
        // Past the first reset's 30 minute deadline, still waiting.
        yield* advance(harness, reactor, HOUR);
        assert.propertyVal((yield* lastRow(harness))?.payload, "state", "waiting");
      }),
    ),
  );

  it.effect("waits for an attempt's outcome, but not forever", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        // No outcome yet: the next slot passes without a second attempt.
        yield* advance(harness, reactor, 9.5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
        // Ten minutes without an outcome counts as a failed attempt.
        yield* advance(harness, reactor, 30_000);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);
      }),
    ),
  );

  it.effect("cancels when the user sends a message", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        // Thread lists show Waiting only while the wait lasts.
        assert.isTrue(harness.waitingIds.has(THREAD_ID));
        yield* publish(harness, reactor, userMessage);

        const cancelled = yield* lastRow(harness);
        assert.strictEqual(cancelled?.summary, "Auto-resume cancelled");
        assert.propertyVal(cancelled?.payload, "state", "stopped");
        assert.isFalse(harness.waitingIds.has(THREAD_ID));
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("does not send once the user has messaged since the limit", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        // The message landed, but its cancel event has not reached the reactor.
        yield* Ref.set(
          harness.thread,
          Option.some(makeThread({ latestUserMessageAt: iso(START + 2 * MINUTE) })),
        );
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
      }),
    ),
  );

  it.effect("tolerates a client clock slightly ahead of the server", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        // The message that hit the limit, stamped by a client 30 seconds fast.
        yield* Ref.set(
          harness.thread,
          Option.some(makeThread({ latestUserMessageAt: iso(START + 30_000) })),
        );
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
      }),
    ),
  );

  it.effect("cancels on Stop but not on a guarded idle stop", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* publish(harness, reactor, stopRequested(true));
        assert.propertyVal((yield* lastRow(harness))?.payload, "state", "waiting");

        yield* publish(harness, reactor, stopRequested(false));
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
        // No attempt was ever sent, so there is nothing to stop.
        assert.deepStrictEqual(yield* Ref.get(harness.stops), []);
      }),
    ),
  );

  it.effect.each([
    { name: "an attempt is out", parked: false },
    { name: "a limited attempt is parked", parked: true },
  ])("Stop ends the session when $name", ({ parked }) =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        if (parked) yield* attemptLimited(harness, reactor);
        yield* publish(harness, reactor, stopRequested(false));
        assert.deepStrictEqual(yield* Ref.get(harness.stops), [{ threadId: THREAD_ID }]);
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
      }),
    ),
  );

  it.effect("Stop leaves the session alone once the user has sent a new message", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        // The user stopped, then sent a message before the reactor got to the Stop.
        yield* Ref.set(
          harness.thread,
          Option.some(makeThread({ latestUserMessageAt: iso(START + 6 * MINUTE) })),
        );
        yield* publish(harness, reactor, stopRequested(false));
        assert.deepStrictEqual(yield* Ref.get(harness.stops), []);
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
      }),
    ),
  );

  it.effect.each(cancellingEvents)("cancels on $type", (event) =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* publish(harness, reactor, event);
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("marks resumed when a failed attempt makes progress after all", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        yield* attemptLimited(harness, reactor);
        // The adapter parked the attempt; it later got through.
        yield* emit(harness, reactor, turnStarted(yield* latestAttemptTurnId(harness)));
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resumed after usage limit");
      }),
    ),
  );

  it.effect("ignores a late failure from an attempt that was replaced", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        const stuckTurnId = yield* latestAttemptTurnId(harness);
        // Ten minutes without an outcome: a second attempt replaces the first.
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);

        yield* emit(harness, reactor, usageLimitError({ autoResume: true, turnId: stuckTurnId }));
        // The second attempt is still out, so no third one is scheduled from the stale failure.
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);
      }),
    ),
  );

  it.effect("keeps waiting when the thread read fails, and retries on the next tick", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* Ref.set(harness.threadReadFailures, 1);
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
        yield* advance(harness, reactor, 30_000);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
        assert.strictEqual((yield* rows(harness)).length, 1);
      }),
    ),
  );

  it.effect("forgets a deleted thread without writing to it", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* publish(harness, reactor, threadDeleted);
        assert.isFalse(harness.waitingIds.has(THREAD_ID));
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.strictEqual((yield* rows(harness)).length, 1);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("gives up 30 minutes after the reset", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 10 * MINUTE }));
        for (let attempt = 0; attempt < 8; attempt += 1) {
          yield* advance(harness, reactor, 5 * MINUTE);
          yield* attemptLimited(harness, reactor);
        }
        const stopped = yield* lastRow(harness);
        assert.strictEqual(
          stopped?.summary,
          "Auto-resume stopped: still limited 30 min after reset",
        );
        assert.propertyVal(stopped?.payload, "state", "stopped");
        assert.strictEqual(stopped?.tone, "error");
        const sent = (yield* Ref.get(harness.sends)).length;
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, sent);
      }),
    ),
  );

  it.effect("gives up after 6 hours when the reset is unknown", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({}));
        yield* Ref.set(harness.sendFails, true);
        yield* advance(harness, reactor, 6 * HOUR);
        assert.strictEqual(
          (yield* lastRow(harness))?.summary,
          "Auto-resume stopped: still limited after 6 hours",
        );
      }),
    ),
  );

  it.effect("does not wait for a reset more than 12 hours away", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 13 * HOUR }));
        const row = yield* lastRow(harness);
        assert.strictEqual(
          row?.summary,
          "Usage limit resets in more than 12 hours. Not auto-resuming.",
        );
        assert.propertyVal(row?.payload, "state", "stopped");
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("retries 5 minutes after a send that fails", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.sendFails, true);
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        yield* Ref.set(harness.sendFails, false);
        yield* advance(harness, reactor, 4.5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
        yield* advance(harness, reactor, 30_000);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 2);
      }),
    ),
  );

  it.effect("waits while the thread is busy or needs an answer", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* Ref.set(harness.thread, Option.some(makeThread({ hasPendingApprovals: true })));
        yield* advance(harness, reactor, 6 * MINUTE);
        const base = makeThread();
        yield* Ref.set(
          harness.thread,
          Option.some(makeThread({ session: { ...base.session!, status: "running" } })),
        );
        yield* advance(harness, reactor, MINUTE);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);

        yield* Ref.set(harness.thread, Option.some(base));
        yield* advance(harness, reactor, 30_000);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
      }),
    ),
  );

  it.effect("cancels when the thread moved to another provider instance", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* Ref.set(
          harness.thread,
          Option.some(makeThread({ modelSelection: { instanceId: CODEX, model: "gpt-5" } })),
        );
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("cancels as soon as the thread switches to another instance", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        // Saving the same instance again changes nothing.
        yield* publish(harness, reactor, instanceChanged(CLAUDE));
        assert.propertyVal((yield* lastRow(harness))?.payload, "state", "waiting");

        yield* publish(harness, reactor, instanceChanged(ProviderInstanceId.make("claude-work")));
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume cancelled");
      }),
    ),
  );

  it.effect("marks a resumed row stopped when Claude then fails", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        const attemptTurnId = yield* latestAttemptTurnId(harness);
        yield* emit(harness, reactor, turnStarted(attemptTurnId));
        yield* emit(harness, reactor, turnCompleted(attemptTurnId, "failed"));

        const [waiting, resumed, failed] = yield* rows(harness);
        assert.propertyVal(resumed?.payload, "state", "resumed");
        assert.strictEqual(failed?.id, waiting?.id);
        assert.strictEqual(failed?.summary, "Auto-resume stopped: Claude failed");
        assert.strictEqual(failed?.tone, "error");
        assert.propertyVal(failed?.payload, "state", "stopped");
      }),
    ),
  );

  it.effect("keeps a resumed row once that turn completes", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        const attemptTurnId = yield* latestAttemptTurnId(harness);
        yield* emit(harness, reactor, turnStarted(attemptTurnId));
        yield* emit(harness, reactor, turnCompleted(attemptTurnId, "completed"));
        // A later failure of another turn is not the attempt's.
        yield* emit(harness, reactor, turnCompleted("later-turn", "failed"));
        assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resumed after usage limit");
      }),
    ),
  );

  it.effect("starts a new wait when a resumed turn hits the limit again", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* advance(harness, reactor, 5 * MINUTE);
        const attemptTurnId = yield* latestAttemptTurnId(harness);
        yield* emit(harness, reactor, turnStarted(attemptTurnId));
        yield* emit(
          harness,
          reactor,
          usageLimitError({ resetsAtMs: START + 3 * HOUR, turnId: attemptTurnId }),
        );
        yield* emit(harness, reactor, turnCompleted(attemptTurnId, "failed"));

        const [first, resumed, second] = yield* rows(harness);
        assert.strictEqual(resumed?.id, first?.id);
        assert.notStrictEqual(second?.id, first?.id);
        assert.propertyVal(second?.payload, "state", "waiting");
        assert.strictEqual((yield* rows(harness)).length, 3);
      }),
    ),
  );

  it.effect("in Auto routing, leaves the limit to account switching", () =>
    run({ thread: autoRoutedThread() }, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        assert.deepStrictEqual(yield* rows(harness), []);
        // Another account took the resent message.
        yield* emit(harness, reactor, turnStarted("resent-turn"));
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* rows(harness), []);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("in Auto routing, waits once no other account took the turn", () =>
    run(
      {
        thread: autoRoutedThread({
          session: { ...makeThread().session!, status: "running", activeTurnId: null },
        }),
      },
      (harness, reactor) =>
        Effect.gen(function* () {
          yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
          yield* publish(harness, reactor, usageLimitResend);
          // Account switching is still settling the turn.
          yield* advance(harness, reactor, 30_000);
          assert.deepStrictEqual(yield* rows(harness), []);

          yield* Ref.set(harness.thread, Option.some(autoRoutedThread()));
          // Idle at one tick is not enough: switching may be about to resend.
          yield* advance(harness, reactor, 30_000);
          assert.deepStrictEqual(yield* rows(harness), []);
          yield* advance(harness, reactor, 30_000);
          const waiting = yield* lastRow(harness);
          assert.strictEqual(waiting?.createdAt, iso(START + 1.5 * MINUTE));
          assert.deepStrictEqual(waiting?.payload, {
            threadId: THREAD_ID,
            instanceId: CLAUDE,
            state: "waiting",
            resetAt: iso(START + 2 * HOUR),
            deadlineAt: iso(START + 2 * HOUR + 30 * MINUTE),
          });
          yield* advance(harness, reactor, 5 * MINUTE);
          assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);
        }),
    ),
  );

  it.effect("in Auto routing, a resend right after an idle tick starts no wait", () =>
    run({ thread: autoRoutedThread() }, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        // The tick lands in the gap between the failed turn settling and the resend.
        yield* advance(harness, reactor, 30_000);
        yield* publish(harness, reactor, usageLimitResend);
        yield* emit(harness, reactor, turnStarted("resent-turn"));
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* rows(harness), []);
      }),
    ),
  );

  it.effect.each([
    { type: "user message", event: userMessage },
    { type: "Stop", event: stopRequested(false) },
    { type: "instance change", event: instanceChanged(CODEX) },
    ...cancellingEvents.map((event) => ({ type: event.type, event })),
  ])("in Auto routing, a $type before the wait starts drops it quietly", ({ event }) =>
    run({ thread: autoRoutedThread() }, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + 2 * HOUR }));
        yield* publish(harness, reactor, event);
        yield* advance(harness, reactor, 10 * MINUTE);
        assert.deepStrictEqual(yield* rows(harness), []);
        assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
      }),
    ),
  );

  it.effect("ignores usage limits from other providers", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ instanceId: CODEX }));
        assert.deepStrictEqual(yield* rows(harness), []);
      }),
    ),
  );

  it.effect("stays off when the setting is off, and stops when it is turned off", () =>
    run(
      { settings: { ...DEFAULT_SERVER_SETTINGS, autoResumeAfterUsageLimit: false } },
      (harness, reactor) =>
        Effect.gen(function* () {
          yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
          assert.deepStrictEqual(yield* rows(harness), []);

          yield* Ref.set(harness.settings, DEFAULT_SERVER_SETTINGS);
          yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
          yield* Ref.set(harness.settings, {
            ...DEFAULT_SERVER_SETTINGS,
            autoResumeAfterUsageLimit: false,
          });
          yield* advance(harness, reactor, 30_000);
          assert.strictEqual((yield* lastRow(harness))?.summary, "Auto-resume turned off");
          yield* advance(harness, reactor, 10 * MINUTE);
          assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
        }),
    ),
  );

  it.effect("reports a turn Claude started itself", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* emit(harness, reactor, turnStarted("cli-turn"));
        yield* emit(harness, reactor, turnCompleted("cli-turn", "completed"));
        assert.strictEqual((yield* lastRow(harness))?.summary, "Usage limit lifted");

        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* emit(harness, reactor, turnStarted("cli-turn-2"));
        yield* emit(harness, reactor, turnCompleted("cli-turn-2", "failed"));
        assert.strictEqual(
          (yield* lastRow(harness))?.summary,
          "Auto-resume stopped: Claude failed",
        );
      }),
    ),
  );

  it.effect("keeps waiting when a turn Claude started itself hits the limit too", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* emit(harness, reactor, turnStarted("cli-turn"));
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* emit(harness, reactor, turnCompleted("cli-turn", "failed"));
        assert.propertyVal((yield* lastRow(harness))?.payload, "state", "waiting");
        assert.strictEqual((yield* rows(harness)).length, 1);
      }),
    ),
  );

  it.effect("keeps waiting when an attempt closes a turn Claude left open", () =>
    run({}, (harness, reactor) =>
      Effect.gen(function* () {
        yield* emit(harness, reactor, usageLimitError({ resetsAtMs: START + HOUR }));
        yield* emit(harness, reactor, turnStarted("cli-turn"));
        yield* advance(harness, reactor, 5 * MINUTE);
        assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);

        yield* emit(harness, reactor, turnCompleted("cli-turn", "completed"));
        yield* attemptLimited(harness, reactor);
        assert.propertyVal((yield* lastRow(harness))?.payload, "state", "waiting");
        assert.strictEqual((yield* rows(harness)).length, 1);
      }),
    ),
  );

  it.effect("picks a waiting cycle back up after a restart", () =>
    run(
      {
        recordedRows: [
          {
            id: EventId.make("usage-limit-auto-resume:limited-thread:1"),
            tone: "info",
            kind: "usage-limit.auto-resume",
            summary: "Usage limit reached. Auto-resuming when it resets.",
            payload: {
              threadId: THREAD_ID,
              instanceId: CLAUDE,
              state: "waiting",
              resetAt: iso(START + HOUR),
              deadlineAt: iso(START + HOUR + 30 * MINUTE),
            },
            turnId: null,
            createdAt: iso(START - HOUR),
          },
        ],
      },
      (harness, reactor) =>
        Effect.gen(function* () {
          assert.isTrue(harness.waitingIds.has(THREAD_ID));
          yield* advance(harness, reactor, 30_000);
          assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
          yield* advance(harness, reactor, 30_000);
          assert.strictEqual((yield* Ref.get(harness.sends)).length, 1);

          yield* emit(harness, reactor, turnStarted("attempt"));
          const resumed = yield* lastRow(harness);
          assert.strictEqual(resumed?.id, "usage-limit-auto-resume:limited-thread:1");
          assert.strictEqual(resumed?.createdAt, iso(START - HOUR));
          assert.strictEqual(resumed?.summary, "Auto-resumed after usage limit");
          assert.isFalse(harness.waitingIds.has(THREAD_ID));
        }),
    ),
  );

  it.effect("gives up 24 hours after a restored wait began", () =>
    run(
      {
        recordedRows: [
          {
            id: EventId.make("usage-limit-auto-resume:limited-thread:1"),
            tone: "info",
            kind: "usage-limit.auto-resume",
            summary: "Usage limit reached. Auto-resuming when it resets.",
            payload: {
              threadId: THREAD_ID,
              instanceId: CLAUDE,
              state: "waiting",
              resetAt: iso(START + 10 * MINUTE),
              deadlineAt: iso(START + 30_000),
            },
            turnId: null,
            createdAt: iso(START - 24 * HOUR),
          },
        ],
      },
      (harness, reactor) =>
        Effect.gen(function* () {
          yield* advance(harness, reactor, 30_000);
          const gaveUp = yield* lastRow(harness);
          assert.strictEqual(gaveUp?.summary, "Auto-resume stopped: still limited after 24 hours");
          assert.strictEqual(gaveUp?.tone, "error");
          assert.deepStrictEqual(yield* Ref.get(harness.sends), []);
        }),
    ),
  );
});
