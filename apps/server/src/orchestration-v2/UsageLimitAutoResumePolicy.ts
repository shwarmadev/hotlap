/**
 * Timing rules for resuming a thread after a provider usage limit. Pure: the
 * reactor feeds in clock readings and reset times, and owns every side effect.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Attempts repeat at this interval while the limit holds. */
const AUTO_RESUME_RETRY_INTERVAL_MS = 5 * MINUTE_MS;
/** One extra attempt lands this long after a known reset. */
const RESET_GRACE_MS = MINUTE_MS;
/** A cycle gives up this long after the latest known reset. */
const GIVE_UP_AFTER_RESET_MS = 30 * MINUTE_MS;
/** Without a known reset, a cycle gives up this long after it starts. */
const UNKNOWN_RESET_GIVE_UP_MS = 6 * HOUR_MS;
/** No wait lasts longer than this, however often the reset moves. */
const MAX_WAIT_MS = 24 * HOUR_MS;
/** Resets further away than this (weekly limits) are not waited for. */
const MAX_RESET_WAIT_MS = 12 * HOUR_MS;
/** An attempt with no outcome after this long is treated as hung. */
const STUCK_ATTEMPT_MS = 10 * MINUTE_MS;

export interface AutoResumeCycle {
  readonly startedAtMs: number;
  /** Latest reset seen for this cycle, when the provider reported one. */
  readonly resetAtMs: number | undefined;
  readonly deadlineAtMs: number;
  readonly nextAttemptAtMs: number;
}

interface ResetReading {
  readonly nowMs: number;
  readonly resetAtMs: number | undefined;
}

/** A reset that already passed says nothing about when the limit lifts. */
const futureReset = ({ nowMs, resetAtMs }: ResetReading) =>
  resetAtMs !== undefined && resetAtMs > nowMs ? resetAtMs : undefined;

/** Starts waiting after a usage-limit failure. Null when the reset is too far away to wait for. */
export function startCycle(reading: ResetReading): AutoResumeCycle | null {
  const resetAtMs = futureReset(reading);
  if (resetAtMs !== undefined && resetAtMs - reading.nowMs > MAX_RESET_WAIT_MS) return null;
  return scheduleNextAttempt(
    {
      startedAtMs: reading.nowMs,
      resetAtMs,
      deadlineAtMs:
        resetAtMs === undefined
          ? reading.nowMs + UNKNOWN_RESET_GIVE_UP_MS
          : resetAtMs + GIVE_UP_AFTER_RESET_MS,
      nextAttemptAtMs: reading.nowMs,
    },
    reading.nowMs,
  );
}

/**
 * Folds in a reset reported by a later limit hit. The latest reset wins, so a
 * swapped-in account that is also limited extends the wait, up to 24 hours
 * from the start. Null when the new reset is too far away to wait for.
 */
export function withLatestReset(
  cycle: AutoResumeCycle,
  reading: ResetReading,
): AutoResumeCycle | null {
  const resetAtMs = futureReset(reading);
  if (resetAtMs === undefined) return cycle;
  if (resetAtMs - reading.nowMs > MAX_RESET_WAIT_MS) return null;
  if (cycle.resetAtMs !== undefined && resetAtMs <= cycle.resetAtMs) return cycle;
  return {
    ...cycle,
    resetAtMs,
    deadlineAtMs: Math.min(resetAtMs + GIVE_UP_AFTER_RESET_MS, cycle.startedAtMs + MAX_WAIT_MS),
  };
}

/** Next attempt: the retry interval, or a minute after the reset when that comes first. */
export function scheduleNextAttempt(cycle: AutoResumeCycle, nowMs: number): AutoResumeCycle {
  const intervalAtMs = nowMs + AUTO_RESUME_RETRY_INTERVAL_MS;
  const resetAttemptAtMs =
    cycle.resetAtMs === undefined ? undefined : cycle.resetAtMs + RESET_GRACE_MS;
  return {
    ...cycle,
    nextAttemptAtMs:
      resetAttemptAtMs !== undefined && resetAttemptAtMs > nowMs
        ? Math.min(intervalAtMs, resetAttemptAtMs)
        : intervalAtMs,
  };
}

export const isCycleExpired = (cycle: AutoResumeCycle, nowMs: number) =>
  nowMs >= cycle.deadlineAtMs;

/** Which limit set the deadline, for the message shown when the wait gives up. */
export function expiryReason(cycle: AutoResumeCycle): "unknownReset" | "afterReset" | "maxWait" {
  if (cycle.resetAtMs === undefined) return "unknownReset";
  return cycle.resetAtMs + GIVE_UP_AFTER_RESET_MS > cycle.startedAtMs + MAX_WAIT_MS
    ? "maxWait"
    : "afterReset";
}

export const isAttemptStuck = (startedAtMs: number, nowMs: number) =>
  nowMs - startedAtMs >= STUCK_ATTEMPT_MS;
