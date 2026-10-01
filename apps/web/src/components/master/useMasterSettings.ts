import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";

// Both preferences resolve to off until client settings hydrate, for the same
// reason as useLegacySidebarEnabled: the pre-hydration snapshot is only schema
// defaults, and swapping trees after hydration would remount everything.

/** Master-first navigation. Wins over the saved legacy sidebar without rewriting it. */
export function useMasterWorkspaceEnabled(): boolean {
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.masterWorkspaceEnabled);
  return hydrated && enabled;
}

export function useMasterStatusBoardEnabled(): boolean {
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.masterStatusBoardEnabled);
  return hydrated && enabled;
}
