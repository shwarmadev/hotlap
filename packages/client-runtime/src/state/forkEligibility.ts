import type { EnvironmentThreadShell } from "./models.ts";

/** Inherited history does not bind a fresh fork to the source provider. */
export function isForkProviderSelectionUnlocked(
  thread:
    | Pick<EnvironmentThreadShell, "forkedFrom" | "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return (
    thread != null &&
    thread.forkedFrom != null &&
    thread.latestRun === null &&
    thread.latestUserMessageAt == null &&
    thread.runtime === null
  );
}
