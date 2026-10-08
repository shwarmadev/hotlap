import { describe, expect, it } from "vite-plus/test";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { presentThreadShell } from "./models.ts";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { isForkProviderSelectionUnlocked } from "./forkEligibility.ts";

const ordinary = presentThreadShell(EnvironmentId.make("environment"), v2ThreadShell);
const freshFork = {
  ...ordinary,
  forkedFrom: {
    type: "message" as const,
    threadId: ThreadId.make("source"),
    messageId: MessageId.make("response"),
  },
  latestRun: null,
  latestUserMessageAt: null,
  runtime: null,
};
describe("fork provider selection", () => {
  it("keeps ordinary threads bound and inherited history provider-independent", () => {
    expect(isForkProviderSelectionUnlocked(ordinary)).toBe(false);
    expect(isForkProviderSelectionUnlocked(null)).toBe(false);
    expect(isForkProviderSelectionUnlocked(freshFork)).toBe(true);
  });
  it("binds the fork once a real submission or provider runtime exists", () => {
    expect(
      isForkProviderSelectionUnlocked({
        ...freshFork,
        latestUserMessageAt: "2026-10-08T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      isForkProviderSelectionUnlocked({
        ...freshFork,
        runtime: {
          status: "failed",
          activeRunId: null,
          providerInstanceId: ordinary.providerInstanceId,
          providerName: null,
          lastError: "error",
          updatedAt: ordinary.updatedAt,
        },
      }),
    ).toBe(false);
  });
});
