import { describe, expect, it } from "vite-plus/test";

import { turnFailureReasonForSession } from "./turnFailure.ts";

describe("turnFailureReasonForSession", () => {
  const usageLimit = {
    kind: "usage_limit" as const,
    message: "Codex usage limit reached.",
    resetsAt: "2026-09-21T01:42:00.000Z",
  };

  it("uses the reason recorded with the session's current error", () => {
    expect(
      turnFailureReasonForSession({ lastError: usageLimit.message, lastErrorReason: usageLimit }),
    ).toEqual(usageLimit);
  });

  // A writer that replaces lastError but spreads the previous session keeps the
  // old reason; showing it would blame the new failure on the old usage limit.
  it("never pairs a new error with a previous failure's reason", () => {
    expect(
      turnFailureReasonForSession({
        lastError:
          "Thread 'thread-1' has an active provider session without a provider instance id.",
        lastErrorReason: usageLimit,
      }),
    ).toEqual({
      kind: "unknown",
      message: "Thread 'thread-1' has an active provider session without a provider instance id.",
    });
  });

  it("has no reason without an error", () => {
    expect(
      turnFailureReasonForSession({ lastError: null, lastErrorReason: usageLimit }),
    ).toBeNull();
    expect(turnFailureReasonForSession(null)).toBeNull();
  });
});
