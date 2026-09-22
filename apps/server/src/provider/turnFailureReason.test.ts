import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyTurnFailureKind, resolveTurnFailureReason } from "./turnFailureReason.ts";

describe("classifyTurnFailureKind", () => {
  // Real sentences the adapters emit today, so a reworded adapter message that
  // stops classifying fails here instead of reaching a user as "unknown".
  it.each([
    [
      "Codex usage limit reached. The weekly limit resets in 32m. Send the message again once the limit resets.",
      "usage_limit",
    ],
    ["Claude usage limit reached. Send the message again once the limit resets.", "usage_limit"],
    ["Claude stopped: a usage limit blocked the request.", "usage_limit"],
    ["429 Too Many Requests", "usage_limit"],
    [
      "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread.",
      "auth",
    ],
    ["401 Unauthorized: invalid API key", "auth"],
    [
      "Thread 'thread-1' cannot switch from instance 'codex' to 'codex_personal' because their provider resume state is incompatible.",
      "session_resume",
    ],
    ["Codex could not resume the conversation: thread not found", "session_resume"],
    ["no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470", "session_resume"],
    ["No conversation found with session ID 4f1c", "session_resume"],
    // A turn-level failure that mentions resuming is not a session resume: the
    // fallback acts on this kind, and must not abandon a resumable session.
    ["Claude could not resume a deferred tool call: the tool is no longer available.", "unknown"],
    ["Codex exited before it could report usage.", "provider_crash"],
    ["cursor-agent crashed with signal SIGSEGV", "provider_crash"],
    ["Claude API is overloaded (529). Try again shortly.", "unknown"],
  ] as const)("reads %j as %s", (message, kind) => {
    expect(classifyTurnFailureKind(message)).toBe(kind);
  });
});

describe("resolveTurnFailureReason", () => {
  const instance = ProviderInstanceId.make("codex_personal");

  it("keeps the adapter's own classification over the message heuristic", () => {
    expect(
      resolveTurnFailureReason({
        reason: {
          kind: "usage_limit",
          message: "Codex usage limit reached.",
          resetsAt: "2026-09-21T01:42:00.000Z",
        },
        message: "the process exited",
        providerInstanceId: instance,
      }),
    ).toEqual({
      kind: "usage_limit",
      message: "Codex usage limit reached.",
      resetsAt: "2026-09-21T01:42:00.000Z",
      providerInstanceId: instance,
    });
  });

  it("classifies a bare provider sentence so a failure is never reasonless", () => {
    expect(
      resolveTurnFailureReason({
        message: "  Codex exited unexpectedly  ",
        providerInstanceId: instance,
      }),
    ).toEqual({
      kind: "provider_crash",
      message: "Codex exited unexpectedly",
      providerInstanceId: instance,
    });
  });

  it("has nothing to say without a reason or a message", () => {
    expect(resolveTurnFailureReason({ message: "   " })).toBeUndefined();
    expect(resolveTurnFailureReason({})).toBeUndefined();
  });
});
