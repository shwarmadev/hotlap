import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { turnFailureHeadline, turnFailureHeadlineForSession } from "./turnFailure.ts";

// A fixed formatter keeps the assertion independent of the machine's locale.
const utcClock = (epochMs: number) =>
  new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(epochMs);

describe("turnFailureHeadline", () => {
  it("names the account and the absolute reset time for a usage limit", () => {
    expect(
      turnFailureHeadline(
        {
          kind: "usage_limit",
          message: "Codex usage limit reached. The weekly limit resets in 32m.",
          resetsAt: "2026-09-21T01:42:00.000Z",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        utcClock,
      ),
    ).toBe("Usage limit reached on codex, resets at 01:42");
  });

  it("says only what it knows when no reset was reported", () => {
    expect(turnFailureHeadline({ kind: "usage_limit", message: "limit" }, utcClock)).toBe(
      "Usage limit reached",
    );
  });

  it("headlines every other kind by what the user does next", () => {
    expect(turnFailureHeadline({ kind: "auth", message: "401" })).toBe("Sign-in needed");
    expect(turnFailureHeadline({ kind: "session_resume", message: "x" })).toBe(
      "The provider session could not resume",
    );
    expect(turnFailureHeadline({ kind: "provider_crash", message: "x" })).toBe(
      "The provider stopped unexpectedly",
    );
    expect(turnFailureHeadline({ kind: "unknown", message: "x" })).toBe("The turn failed");
  });

  it("headlines a session's own error, never a reason left over from an earlier one", () => {
    const earlier = { kind: "usage_limit" as const, message: "Codex usage limit reached." };
    expect(
      turnFailureHeadlineForSession({ lastError: "401 Unauthorized", lastErrorReason: earlier }),
    ).toBe("The turn failed");
    expect(
      turnFailureHeadlineForSession({ lastError: earlier.message, lastErrorReason: earlier }),
    ).toBe("Usage limit reached");
  });
});
