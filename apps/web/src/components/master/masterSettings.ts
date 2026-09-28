import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import type { SettingsSearchItem } from "../settings/settingsSearch";

/**
 * Master workspace settings, owned here so upstream settings files only carry
 * one-line mount points. Both preferences are client-local and default off.
 * They reset from their own rows rather than the panel-wide "Restore defaults",
 * which would need Master bookkeeping inside SettingsPanels.
 */
export const MASTER_SETTINGS_SEARCH_ITEMS = [
  {
    id: "master-workspace",
    title: "Master workspace",
    to: "/settings/general",
    searchTerms: ["master pinned projects cards one-off sidebar personal"],
  },
  {
    id: "master-status-board",
    title: "Master status board",
    to: "/settings/general",
    searchTerms: ["master card status board threads workflow"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const MASTER_SETTINGS_DEFAULTS = {
  masterWorkspaceEnabled: DEFAULT_UNIFIED_SETTINGS.masterWorkspaceEnabled,
  masterStatusBoardEnabled: DEFAULT_UNIFIED_SETTINGS.masterStatusBoardEnabled,
} as const;
