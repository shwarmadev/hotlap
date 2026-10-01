import { SettingResetButton, SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Switch } from "../ui/switch";
import { MASTER_SETTINGS_DEFAULTS } from "./masterSettings";

/** The two Master rows under Settings → General → Projects & threads. */
export function MasterSettingsRows() {
  const masterWorkspaceEnabled = useScopedSettings((settings) => settings.masterWorkspaceEnabled);
  const masterStatusBoardEnabled = useScopedSettings(
    (settings) => settings.masterStatusBoardEnabled,
  );
  const updateSettings = useUpdateScopedSettings();

  return (
    <>
      <SettingsRow
        {...searchableSetting("master-workspace")}
        description="Use Pinned Masters and compact project trees in this client. Existing sidebar preferences stay saved."
        resetAction={
          masterWorkspaceEnabled !== MASTER_SETTINGS_DEFAULTS.masterWorkspaceEnabled ? (
            <SettingResetButton
              label="Master workspace"
              onClick={() =>
                updateSettings({
                  masterWorkspaceEnabled: MASTER_SETTINGS_DEFAULTS.masterWorkspaceEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={masterWorkspaceEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ masterWorkspaceEnabled: Boolean(checked) })
            }
            aria-label="Master workspace"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("master-status-board")}
        description="Show owned Card threads and other Masters above Master and Card chats."
        resetAction={
          masterStatusBoardEnabled !== MASTER_SETTINGS_DEFAULTS.masterStatusBoardEnabled ? (
            <SettingResetButton
              label="Master status board"
              onClick={() =>
                updateSettings({
                  masterStatusBoardEnabled: MASTER_SETTINGS_DEFAULTS.masterStatusBoardEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={masterStatusBoardEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ masterStatusBoardEnabled: Boolean(checked) })
            }
            aria-label="Master status board"
          />
        }
      />
    </>
  );
}
