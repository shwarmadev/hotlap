import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The Effect test clock starts at the epoch.
const BEFORE_NOW = "1969-12-30T00:00:00.000Z";
const SNOOZED_AT = "1969-12-31T00:00:00.000Z";
const FUTURE_WAKE = "1970-01-02T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        providerRoutingMode: "fixed",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const reorderCommand = {
  type: "thread.active.reorder",
  commandId: CommandId.make("cmd-active-reorder"),
  threadId: THREAD_ID,
  orderKey: "m",
} as const;

it.layer(NodeServices.layer)("active thread ordering", (it) => {
  it.effect("persists provider routing mode metadata", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-routing-auto"),
          threadId: THREAD_ID,
          providerRoutingMode: "auto",
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toMatchObject([
        {
          type: "thread.meta-updated",
          payload: { providerRoutingMode: "auto" },
        },
      ]);
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.providerRoutingMode).toBe("auto");
    }),
  );

  it.effect("keeps a started Claude thread fixed when a client asks for automatic routing", () =>
    Effect.gen(function* () {
      const claudeThread = {
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" },
        session: {
          threadId: THREAD_ID,
          status: "ready" as const,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claude"),
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      };
      const command = {
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-claude-routing-auto"),
        threadId: THREAD_ID,
        providerRoutingMode: "auto",
      } as const;

      const started = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel({
          ...claudeThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        }),
      });
      expect(Array.isArray(started) ? started : [started]).toMatchObject([
        { type: "thread.meta-updated", payload: { providerRoutingMode: "fixed" } },
      ]);

      // Before its first turn, a Claude thread can still pick an account automatically.
      const unstarted = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(claudeThread),
      });
      expect(Array.isArray(unstarted) ? unstarted : [unstarted]).toMatchObject([
        { type: "thread.meta-updated", payload: { providerRoutingMode: "auto" } },
      ]);
    }),
  );

  it.effect("pins automatic routing when an implicit model update changes provider instance", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ providerRoutingMode: "auto" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-legacy-account-pick"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.4",
          },
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toMatchObject([
        {
          type: "thread.meta-updated",
          payload: {
            modelSelection: { instanceId: "codex-work" },
            providerRoutingMode: "fixed",
          },
        },
      ]);
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.providerRoutingMode).toBe("fixed");
    }),
  );

  it.effect("preserves automatic routing for an implicit same-instance model update", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ providerRoutingMode: "auto" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-same-account-model-change"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4-mini",
          },
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events[0]).toMatchObject({
        type: "thread.meta-updated",
        payload: { modelSelection: { instanceId: "codex", model: "gpt-5.4-mini" } },
      });
      expect(events[0]?.payload).not.toHaveProperty("providerRoutingMode");
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.providerRoutingMode).toBe("auto");
    }),
  );

  it.effect("honors an explicit routing mode when the provider instance changes", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ providerRoutingMode: "fixed" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-automatic-account-route"),
          threadId: THREAD_ID,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.4",
          },
          providerRoutingMode: "auto",
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toMatchObject([
        {
          type: "thread.meta-updated",
          payload: {
            modelSelection: { instanceId: "codex-work" },
            providerRoutingMode: "auto",
          },
        },
      ]);
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.providerRoutingMode).toBe("auto");
    }),
  );

  it.effect("commits an automatic route and its audit activity together", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ providerRoutingMode: "auto" });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.provider-account.route",
          commandId: CommandId.make("cmd-atomic-account-route"),
          threadId: THREAD_ID,
          previousProviderInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.4",
          },
          providerRoutingMode: "auto",
          activity: {
            id: EventId.make("activity-atomic-account-route"),
            tone: "info",
            kind: "provider.account.routed",
            summary: "Switched provider account",
            payload: {
              previousProviderInstanceId: "codex",
              providerInstanceId: "codex-work",
              reason: "usage-threshold",
            },
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events).toMatchObject([
        {
          type: "thread.meta-updated",
          payload: {
            modelSelection: { instanceId: "codex-work" },
            providerRoutingMode: "auto",
          },
        },
        {
          type: "thread.activity-appended",
          payload: { activity: { kind: "provider.account.routed" } },
        },
      ]);
    }),
  );

  it.effect("rejects an automatic route after another account change wins", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.provider-account.route",
          commandId: CommandId.make("cmd-stale-account-route"),
          threadId: THREAD_ID,
          previousProviderInstanceId: ProviderInstanceId.make("codex-old"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.4",
          },
          providerRoutingMode: "auto",
          activity: {
            id: EventId.make("activity-stale-account-route"),
            tone: "info",
            kind: "provider.account.routed",
            summary: "Switched provider account",
            payload: {},
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("persists changed and repeated slots without changing thread activity timestamps", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel({ unsettledAt: BEFORE_NOW });
      for (const orderKey of ["m", "m", "g"]) {
        const decided = yield* decideOrchestrationCommand({
          command: { ...reorderCommand, orderKey },
          readModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.meta-updated",
          payload: { threadId: THREAD_ID, activeOrderKey: orderKey, updatedAt: NOW },
        });
        for (const event of events) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        expect(readModel.threads[0]).toMatchObject({
          activeOrderKey: orderKey,
          updatedAt: NOW,
          createdAt: NOW,
          unsettledAt: BEFORE_NOW,
        });
      }
    }),
  );

  for (const [label, overrides] of [
    ["archived", { archivedAt: NOW }],
    ["deleted", { deletedAt: NOW }],
    ["pinned", { pinnedAt: NOW }],
    ["settled", { settledOverride: "settled", settledAt: NOW }],
  ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationThread>]>) {
    it.effect(`rejects reordering a ${label} thread`, () =>
      Effect.gen(function* () {
        const error = yield* decideOrchestrationCommand({
          command: reorderCommand,
          readModel: makeReadModel(overrides),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }),
    );
  }

  it.effect("reorders a running thread without affecting its session", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      });
      const decided = yield* decideOrchestrationCommand({ command: reorderCommand, readModel });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      for (const event of events) {
        const projected = yield* projectEvent(readModel, { ...event, sequence: 1 });
        expect(projected.threads[0]).toEqual({ ...readModel.threads[0], activeOrderKey: "m" });
      }
    }),
  );

  it.effect(
    "changes a snoozed thread's retained slot without waking it or changing timestamps",
    () =>
      Effect.gen(function* () {
        const readModel = makeReadModel({
          activeOrderKey: "g",
          snoozedAt: SNOOZED_AT,
          snoozedUntil: FUTURE_WAKE,
          unsettledAt: BEFORE_NOW,
        });
        const decided = yield* decideOrchestrationCommand({ command: reorderCommand, readModel });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        for (const event of events) {
          const projected = yield* projectEvent(readModel, { ...event, sequence: 1 });
          expect(projected.threads[0]).toEqual({ ...readModel.threads[0], activeOrderKey: "m" });
        }
      }),
  );

  it.effect("keeps placement through metadata, pin and snooze, then resets it on settlement", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel();
      const steps = [
        [reorderCommand, "m"],
        [{ type: "thread.meta.update", title: "Renamed" }, "m"],
        [{ type: "thread.pin", orderKey: "g" }, "m"],
        [{ type: "thread.snooze", snoozedUntil: FUTURE_WAKE }, "m"],
        [{ type: "thread.unsnooze", reason: "user" }, "m"],
        [{ type: "thread.unpin" }, "m"],
        [{ type: "thread.settle" }, null],
        [{ type: "thread.unsettle", reason: "user" }, null],
        [{ type: "thread.active.reorder", orderKey: "s" }, "s"],
      ] as const;
      for (const [index, [step, expectedKey]] of steps.entries()) {
        const command: OrchestrationCommand = {
          ...step,
          commandId: CommandId.make(`lifecycle-${index}`),
          threadId: THREAD_ID,
        };
        const decided = yield* decideOrchestrationCommand({ command, readModel });
        const events = Array.isArray(decided) ? decided : [decided];
        for (const event of events) {
          readModel = yield* projectEvent(readModel, {
            ...event,
            sequence: readModel.snapshotSequence + 1,
          });
        }
        expect(readModel.threads[0]?.activeOrderKey, command.type).toBe(expectedKey);
      }
      expect(readModel.threads[0]).toMatchObject({
        title: "Renamed",
        settledOverride: "active",
        settledAt: null,
        snoozedUntil: null,
        pinnedAt: null,
      });
    }),
  );
});
