import { describe, expect, it } from "vite-plus/test";

import {
  expiryReason,
  isAttemptStuck,
  isCycleExpired,
  scheduleNextAttempt,
  startCycle,
  withLatestReset,
} from "./UsageLimitAutoResumePolicy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-09-28T01:00:00.000Z");

describe("startCycle", () => {
  it("gives up 30 minutes after a known reset and retries in 5 minutes", () => {
    expect(startCycle({ nowMs: NOW, resetAtMs: NOW + 2 * HOUR })).toEqual({
      startedAtMs: NOW,
      resetAtMs: NOW + 2 * HOUR,
      deadlineAtMs: NOW + 2 * HOUR + 30 * MINUTE,
      nextAttemptAtMs: NOW + 5 * MINUTE,
    });
  });

  it("tries once a minute after a reset that lands before the next interval", () => {
    expect(startCycle({ nowMs: NOW, resetAtMs: NOW + 2 * MINUTE })?.nextAttemptAtMs).toBe(
      NOW + 3 * MINUTE,
    );
  });

  it("caps an unknown reset at 6 hours", () => {
    expect(startCycle({ nowMs: NOW, resetAtMs: undefined })).toEqual({
      startedAtMs: NOW,
      resetAtMs: undefined,
      deadlineAtMs: NOW + 6 * HOUR,
      nextAttemptAtMs: NOW + 5 * MINUTE,
    });
  });

  it("treats a reset that already passed as unknown", () => {
    expect(startCycle({ nowMs: NOW, resetAtMs: NOW - MINUTE })?.deadlineAtMs).toBe(NOW + 6 * HOUR);
  });

  it("does not wait for a reset more than 12 hours away", () => {
    expect(startCycle({ nowMs: NOW, resetAtMs: NOW + 12 * HOUR + MINUTE })).toBeNull();
    expect(startCycle({ nowMs: NOW, resetAtMs: NOW + 12 * HOUR })).not.toBeNull();
  });
});

describe("withLatestReset", () => {
  const cycle = startCycle({ nowMs: NOW, resetAtMs: NOW + HOUR })!;

  it("moves the deadline to a later reset", () => {
    expect(withLatestReset(cycle, { nowMs: NOW, resetAtMs: NOW + 3 * HOUR })).toEqual({
      ...cycle,
      resetAtMs: NOW + 3 * HOUR,
      deadlineAtMs: NOW + 3 * HOUR + 30 * MINUTE,
    });
  });

  it("keeps the latest reset when an earlier or unknown one arrives", () => {
    expect(withLatestReset(cycle, { nowMs: NOW, resetAtMs: NOW + 10 * MINUTE })).toEqual(cycle);
    expect(withLatestReset(cycle, { nowMs: NOW, resetAtMs: undefined })).toEqual(cycle);
  });

  it("replaces the 6 hour cap once a reset is known", () => {
    const unknown = startCycle({ nowMs: NOW, resetAtMs: undefined })!;
    expect(withLatestReset(unknown, { nowMs: NOW, resetAtMs: NOW + HOUR })?.deadlineAtMs).toBe(
      NOW + HOUR + 30 * MINUTE,
    );
  });

  it("stops when the new reset is more than 12 hours away", () => {
    expect(withLatestReset(cycle, { nowMs: NOW, resetAtMs: NOW + 13 * HOUR })).toBeNull();
  });

  it("never moves the deadline past 24 hours from the start", () => {
    const later = NOW + 20 * HOUR;
    expect(withLatestReset(cycle, { nowMs: later, resetAtMs: later + 10 * HOUR })).toEqual({
      ...cycle,
      resetAtMs: later + 10 * HOUR,
      deadlineAtMs: NOW + 24 * HOUR,
    });
  });
});

describe("expiryReason", () => {
  it("names the limit that ended the wait", () => {
    const unknown = startCycle({ nowMs: NOW, resetAtMs: undefined })!;
    expect(expiryReason(unknown)).toBe("unknownReset");
    const known = startCycle({ nowMs: NOW, resetAtMs: NOW + HOUR })!;
    expect(expiryReason(known)).toBe("afterReset");
    const later = NOW + 20 * HOUR;
    const capped = withLatestReset(known, { nowMs: later, resetAtMs: later + 10 * HOUR })!;
    expect(expiryReason(capped)).toBe("maxWait");
  });
});

describe("scheduleNextAttempt", () => {
  it("retries every 5 minutes", () => {
    const cycle = startCycle({ nowMs: NOW, resetAtMs: NOW + 2 * HOUR })!;
    expect(scheduleNextAttempt(cycle, NOW + HOUR).nextAttemptAtMs).toBe(NOW + HOUR + 5 * MINUTE);
  });

  it("pulls the attempt forward to a minute after the reset", () => {
    const cycle = startCycle({ nowMs: NOW, resetAtMs: NOW + 2 * HOUR })!;
    expect(scheduleNextAttempt(cycle, NOW + 2 * HOUR - 2 * MINUTE).nextAttemptAtMs).toBe(
      NOW + 2 * HOUR + MINUTE,
    );
  });

  it("goes back to 5 minutes once the reset attempt has passed", () => {
    const cycle = startCycle({ nowMs: NOW, resetAtMs: NOW + 2 * HOUR })!;
    const afterReset = NOW + 2 * HOUR + MINUTE;
    expect(scheduleNextAttempt(cycle, afterReset).nextAttemptAtMs).toBe(afterReset + 5 * MINUTE);
  });
});

describe("isCycleExpired", () => {
  it("expires at the deadline", () => {
    const cycle = startCycle({ nowMs: NOW, resetAtMs: NOW + HOUR })!;
    expect(isCycleExpired(cycle, cycle.deadlineAtMs - 1)).toBe(false);
    expect(isCycleExpired(cycle, cycle.deadlineAtMs)).toBe(true);
  });
});

describe("isAttemptStuck", () => {
  it("flags an attempt without an outcome after 10 minutes", () => {
    expect(isAttemptStuck(NOW, NOW + 10 * MINUTE - 1)).toBe(false);
    expect(isAttemptStuck(NOW, NOW + 10 * MINUTE)).toBe(true);
  });
});
