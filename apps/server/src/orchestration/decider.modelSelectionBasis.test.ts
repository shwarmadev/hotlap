import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-21T01:40:00.000Z";
const SHARED: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const PERSONAL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  model: "gpt-5.4",
};

/** A started thread the user has already switched from the shared account to personal. */
function switchedThread(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Bug fixer",
        modelSelection: PERSONAL,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: PERSONAL.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  };
}

const turnStart = (input: {
  readonly modelSelection: ModelSelection;
  readonly expectedModelSelection?: ModelSelection;
}) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-queued-turn"),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make("message-queued"),
      role: "user",
      text: "continue",
      attachments: [],
    },
    modelSelection: input.modelSelection,
    ...(input.expectedModelSelection !== undefined
      ? { expectedModelSelection: input.expectedModelSelection }
      : {}),
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  }) as const;

const decide = (command: Parameters<typeof decideOrchestrationCommand>[0]["command"]) =>
  decideOrchestrationCommand({ command, readModel: switchedThread() }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("model selection compare-and-set", (it) => {
  it.effect("drops a queued selection write built before the thread was switched", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-outbox-settings"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: SHARED,
        expectedModelSelection: SHARED,
        providerRoutingMode: "fixed",
      });
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.type).toBe("thread.meta-updated");
      if (event?.type !== "thread.meta-updated") return;
      expect(event.payload.modelSelection).toBeUndefined();
      expect(event.payload.providerRoutingMode).toBeUndefined();
    }),
  );

  it.effect("applies a selection write whose basis is still the thread's selection", () =>
    Effect.gen(function* () {
      const [event] = yield* decide({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-deliberate-switch"),
        threadId: ThreadId.make("thread-1"),
        modelSelection: SHARED,
        expectedModelSelection: PERSONAL,
      });
      expect(event?.type === "thread.meta-updated" && event.payload.modelSelection).toEqual(SHARED);
    }),
  );

  it.effect("runs a stale turn on the thread's selection and says so on the thread", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        turnStart({ modelSelection: SHARED, expectedModelSelection: SHARED }),
      );
      const requested = events.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.type === "thread.turn-start-requested" && requested.payload).toMatchObject({
        modelSelection: PERSONAL,
      });
      const notice = events.find(
        (event) =>
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "thread.model-selection.superseded",
      );
      expect(notice?.type === "thread.activity-appended" && notice.payload.activity).toMatchObject({
        tone: "info",
        payload: { requested: SHARED, applied: PERSONAL },
      });
    }),
  );

  it.effect("says nothing when a stale sender already asks for the thread's selection", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        turnStart({ modelSelection: PERSONAL, expectedModelSelection: SHARED }),
      );
      expect(events.some((event) => event.type === "thread.activity-appended")).toBe(false);
    }),
  );

  it.effect("matches a basis whose options were serialised in another key order", () =>
    Effect.gen(function* () {
      const withOptions = (order: "ab" | "ba") =>
        ({
          ...PERSONAL,
          options:
            order === "ab"
              ? { reasoningEffort: "high", fastMode: true }
              : { fastMode: true, reasoningEffort: "high" },
        }) as unknown as ModelSelection;
      const events = yield* decideOrchestrationCommand({
        command: turnStart({ modelSelection: SHARED, expectedModelSelection: withOptions("ba") }),
        readModel: {
          ...switchedThread(),
          threads: switchedThread().threads.map((thread) => ({
            ...thread,
            modelSelection: withOptions("ab"),
          })),
        },
      }).pipe(Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])));
      const requested = events.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.type === "thread.turn-start-requested" && requested.payload).toMatchObject({
        modelSelection: SHARED,
      });
    }),
  );

  it.effect("leaves a turn without a basis exactly as sent, for older clients", () =>
    Effect.gen(function* () {
      const events = yield* decide(turnStart({ modelSelection: SHARED }));
      const requested = events.find((event) => event.type === "thread.turn-start-requested");
      expect(requested?.type === "thread.turn-start-requested" && requested.payload).toMatchObject({
        modelSelection: SHARED,
      });
      expect(events.some((event) => event.type === "thread.activity-appended")).toBe(false);
    }),
  );
});
