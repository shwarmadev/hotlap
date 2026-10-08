import { MessageId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { hotlapLimitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const now = Date.parse("2026-10-08T00:00:00.000Z");
const minute = 60_000;
const candidate = (
  overrides: Partial<ProjectionLimitRecoveryCandidate> = {},
): ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("claude-instance"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("run"),
  usageLimitResetAt: null,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: DateTime.makeUnsafe(now),
  updatedAt: DateTime.makeUnsafe(now),
  limitRecovery: null,
  snoozedUntil: null,
  ...overrides,
});
const armed = (thread = candidate()) => {
  const command = hotlapLimitRecoveryCommand(thread, true, true, now);
  if (command?.type !== "thread.metadata.update" || !command.limitRecovery)
    throw new Error("Expected cycle arm");
  return candidate({
    ...thread,
    limitRecovery: {
      ...command.limitRecovery,
      autoResume: command.limitRecovery.autoResume ?? false,
      snooze: false,
    },
  });
};

describe("Hotlap persisted usage-limit recovery", () => {
  it("arms unknown resets with a five-minute retry and six-hour deadline", () => {
    const cycle = armed().limitRecovery?.hotlapCycle;
    expect(cycle).toMatchObject({
      startedAtMs: now,
      nextAttemptAtMs: now + 5 * minute,
      deadlineAtMs: now + 360 * minute,
    });
    expect(armed().limitRecovery?.resetAt).toBeNull();
  });
  it("does not run early, then sends an idempotent hidden continuation", () => {
    const thread = armed();
    expect(hotlapLimitRecoveryCommand(thread, true, true, now + 4 * minute)).toBeNull();
    const command = hotlapLimitRecoveryCommand(thread, true, true, now + 5 * minute);
    expect(command?.type).toBe("message.dispatch");
    if (command?.type !== "message.dispatch") throw new Error("Expected retry");
    expect(command.messageId.startsWith("hotlap-limit-resume:")).toBe(true);
    expect(command.usageLimitContinuationOfRunId).toBe(thread.latestRunId);
    expect(hotlapLimitRecoveryCommand(thread, true, true, now + 6 * minute)).toEqual(command);
  });
  it("retains the original budget after a failed background retry", () => {
    const thread = candidate({
      ...armed(),
      latestRunId: RunId.make("retry"),
      latestRunMessageId: MessageId.make("hotlap-limit-resume:retry"),
    });
    const command = hotlapLimitRecoveryCommand(thread, true, true, now + 5 * minute);
    expect(command?.type).toBe("thread.metadata.update");
    if (command?.type !== "thread.metadata.update") throw new Error("Expected reschedule");
    expect(command.limitRecovery?.hotlapCycle).toMatchObject({
      startedAtMs: now,
      nextAttemptAtMs: now + 10 * minute,
      deadlineAtMs: now + 360 * minute,
    });
  });
  it("starts a fresh budget for a new user failure", () => {
    const thread = candidate({
      ...armed(),
      latestRunId: RunId.make("foreground"),
      latestRunMessageId: MessageId.make("user-message"),
    });
    const command = hotlapLimitRecoveryCommand(thread, true, true, now + 30 * minute);
    if (command?.type !== "thread.metadata.update") throw new Error("Expected new cycle");
    expect(command.limitRecovery?.hotlapCycle?.startedAtMs).toBe(now + 30 * minute);
  });
  it("stops after the deadline or when disabled", () => {
    for (const [enabled, time] of [
      [false, now],
      [true, now + 360 * minute],
    ] as const) {
      const command = hotlapLimitRecoveryCommand(armed(), enabled, true, time);
      if (command?.type !== "thread.metadata.update") throw new Error("Expected stop");
      expect(command.limitRecovery?.autoResume).toBe(false);
    }
  });
  it("respects explicit cancellation, provider identity and busy state", () => {
    const thread = armed();
    expect(
      hotlapLimitRecoveryCommand(
        candidate({ ...thread, limitRecovery: { ...thread.limitRecovery!, autoResume: false } }),
        true,
        true,
        now + 5 * minute,
      ),
    ).toBeNull();
    expect(hotlapLimitRecoveryCommand(candidate(), true, false, now)).toBeNull();
    expect(
      hotlapLimitRecoveryCommand(
        candidate({ ...thread, archivedAt: DateTime.makeUnsafe(now) }),
        true,
        true,
        now + 5 * minute,
      ),
    ).toBeNull();
  });
  it("does not wait for weekly resets and schedules the reset grace attempt", () => {
    expect(
      hotlapLimitRecoveryCommand(
        candidate({ usageLimitResetAt: new Date(now + 13 * 60 * minute).toISOString() }),
        true,
        true,
        now,
      ),
    ).toBeNull();
    const thread = armed(
      candidate({ usageLimitResetAt: new Date(now + 2 * minute).toISOString() }),
    );
    expect(thread.limitRecovery?.hotlapCycle?.nextAttemptAtMs).toBe(now + 3 * minute);
  });
});
