import { isForkProviderSelectionUnlocked } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { ProviderGroup } from "../../lib/modelOptions";

type ThreadProviderSelectionState = Pick<
  EnvironmentThreadShell,
  "forkedFrom" | "latestRun" | "latestUserMessageAt" | "modelSelection" | "runtime"
>;

export function resolveThreadProviderGroups(
  thread: ThreadProviderSelectionState,
  providerGroups: ReadonlyArray<ProviderGroup>,
  queuedSubmissionCount: number,
): ReadonlyArray<ProviderGroup> {
  if (queuedSubmissionCount === 0 && isForkProviderSelectionUnlocked(thread)) {
    return providerGroups;
  }

  return providerGroups.filter((group) => group.providerKey === thread.modelSelection.instanceId);
}
