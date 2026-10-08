import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderGroup } from "../../lib/modelOptions";
import { resolveThreadProviderGroups } from "./thread-provider-groups";

type SelectionState = Parameters<typeof resolveThreadProviderGroups>[0];
const providerGroups: ReadonlyArray<ProviderGroup> = [
  { providerKey: "codex", providerLabel: "Codex", models: [] },
  { providerKey: "claude", providerLabel: "Claude", models: [] },
];
function thread(overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    forkedFrom: {
      type: "message",
      threadId: ThreadId.make("source"),
      messageId: MessageId.make("response"),
    },
    latestRun: null,
    latestUserMessageAt: null,
    runtime: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    ...overrides,
  };
}
describe("mobile fork provider selection", () => {
  it("offers every provider while a fork has inherited history only", () => {
    expect(resolveThreadProviderGroups(thread(), providerGroups, 0)).toEqual(providerGroups);
  });
  it("binds provider selection when a submission is queued", () => {
    expect(resolveThreadProviderGroups(thread(), providerGroups, 1)).toEqual([providerGroups[0]]);
  });
  it("binds ordinary threads and forks with a real user submission", () => {
    expect(resolveThreadProviderGroups(thread({ forkedFrom: null }), providerGroups, 0)).toEqual([
      providerGroups[0],
    ]);
    expect(
      resolveThreadProviderGroups(
        thread({ latestUserMessageAt: "2026-09-15T00:00:00Z" }),
        providerGroups,
        0,
      ),
    ).toEqual([providerGroups[0]]);
  });
});
