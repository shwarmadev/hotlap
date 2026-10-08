import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RetryPolicy from "./UsageLimitAutoResumePolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/** Claude retries persist their budget and next due time across restarts. */
export function hotlapLimitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  enabled: boolean,
  isClaude: boolean,
  nowMs: number,
): OrchestrationV2Command | null {
  const latestRunId = thread.latestRunId;
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const recovery = thread.limitRecovery;
  const previous = recovery?.hotlapCycle;
  const resetAt = thread.usageLimitResetAt ?? null;
  const resetAtMs = resetAt === null ? undefined : Date.parse(resetAt);
  const reading = {
    nowMs,
    resetAtMs: resetAtMs !== undefined && Number.isFinite(resetAtMs) ? resetAtMs : undefined,
  };
  const inherited =
    previous !== undefined &&
    previous.instanceId === thread.providerInstanceId &&
    (recovery?.runId === latestRunId ||
      thread.latestRunMessageId?.startsWith("hotlap-limit-resume:") === true);
  const identity = `${thread.id}:${latestRunId}:${resetAt ?? "unknown"}`;
  const update = (
    cycle: NonNullable<typeof previous>,
    autoResume: boolean,
  ): OrchestrationV2Command => ({
    type: "thread.metadata.update",
    commandId: CommandId.make(
      `hotlap-limit-arm:${identity}:${cycle.startedAtMs}:${cycle.nextAttemptAtMs}:${autoResume}`,
    ),
    threadId: thread.id,
    limitRecovery: { runId: latestRunId, resetAt, autoResume, hotlapCycle: cycle },
  });
  if (!enabled || !isClaude) {
    return previous !== undefined && recovery?.autoResume === true ? update(previous, false) : null;
  }
  // A user's cancellation stays cancelled until a new foreground failure starts a cycle.
  if (inherited && recovery?.autoResume === false) return null;
  let cycle = inherited
    ? RetryPolicy.withLatestReset({ ...previous, resetAtMs: previous.resetAtMs }, reading)
    : RetryPolicy.startCycle(reading);
  if (cycle === null || RetryPolicy.isCycleExpired(cycle, nowMs)) {
    return previous !== undefined && recovery?.autoResume === true ? update(previous, false) : null;
  }
  if (inherited && recovery?.runId !== latestRunId)
    cycle = RetryPolicy.scheduleNextAttempt(cycle, nowMs);
  const persisted = { ...cycle, instanceId: thread.providerInstanceId };
  if (
    !inherited ||
    recovery?.runId !== latestRunId ||
    recovery.resetAt !== resetAt ||
    cycle.resetAtMs !== previous?.resetAtMs ||
    cycle.deadlineAtMs !== previous?.deadlineAtMs
  )
    return update(persisted, true);
  if (
    nowMs < cycle.nextAttemptAtMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${cycle.startedAtMs}:${cycle.nextAttemptAtMs}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`hotlap-limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`hotlap-limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      hotlapAutoResume: preferences.autoResumeAfterUsageLimit,
    });
    const nowMs = DateTime.toEpochMillis(now);
    const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
    const claudeInstances = new Set(
      providers
        .filter((provider) => provider.driver === "claudeAgent")
        .map((provider) => provider.instanceId),
    );
    for (const thread of candidates) {
      const isClaude =
        claudeInstances.has(thread.providerInstanceId) ||
        preferences.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent";
      const command =
        (isClaude && preferences.autoResumeAfterUsageLimit) ||
        thread.limitRecovery?.hotlapCycle !== undefined
          ? hotlapLimitRecoveryCommand(
              thread,
              preferences.autoResumeAfterUsageLimit,
              isClaude,
              nowMs,
            )
          : limitRecoveryCommand(
              thread,
              preferences.autoResumeLimitedThreads,
              nowMs,
              preferences.snoozeLimitedThreads,
            );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
