import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderRoutingMode,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { Checkbox } from "../ui/checkbox";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import {
  canEnableProviderRoutingAutoOnEveryTarget,
  deriveProviderRoutingOptions,
  mergeProviderRoutingOptions,
  providerRoutingThresholdPatch,
  resolveTargetProviderRoutingPolicyPatch,
  supportsProviderAccountRouting,
  toggleProviderRoutingInstance,
} from "./ProviderRoutingSettings.logic";
import type { ProviderRoutingPolicyPatch } from "./scopedSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedProviderRoutingPolicy,
} from "./useScopedSettings";

const DRIVER_LABELS: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};
const ROUTABLE_DRIVERS = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
] as const;

export function ProviderRoutingSettings() {
  const { scope, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updatePolicy = useUpdateScopedProviderRoutingPolicy();
  const mixed = useScopedSettingsMixed(["providerRoutingPolicy"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const targetEnvironments = useMemo(
    () =>
      targets.map((target) =>
        connectedEnvironments.find(
          (environment) => environment.environmentId === target.environmentId,
        ),
      ),
    [connectedEnvironments, targets],
  );
  const supported =
    targetEnvironments.length > 0 &&
    targetEnvironments.every((environment) =>
      supportsProviderAccountRouting(environment?.serverConfig?.environment.capabilities),
    );
  const options = useMemo(
    () =>
      deriveProviderRoutingOptions(
        targetEnvironments.flatMap((environment) =>
          environment?.serverConfig ? [environment.serverConfig.providers] : [],
        ),
      ),
    [targetEnvironments],
  );

  if (!isProjectScope || !supported) return null;

  const policy = settings.providerRoutingPolicy;
  const groupedOptions = new Map<ProviderDriverKind, Array<(typeof options)[number]>>();
  for (const option of options) {
    const existing = groupedOptions.get(option.driver);
    if (existing) existing.push(option);
    else groupedOptions.set(option.driver, [option]);
  }
  for (const driver of ROUTABLE_DRIVERS) {
    if ((policy.instanceIdsByDriver[driver]?.length ?? 0) > 0 && !groupedOptions.has(driver)) {
      groupedOptions.set(driver, []);
    }
  }
  // Each target is validated against its own environment's accounts and default account.
  const providersFor = (environmentId: EnvironmentId) =>
    targetEnvironments.find((environment) => environment?.environmentId === environmentId)
      ?.serverConfig?.providers ?? [];
  const canEnableAuto = canEnableProviderRoutingAutoOnEveryTarget(
    targets.map((target) => ({
      settings: target.settings,
      providers: providersFor(target.environmentId),
    })),
  );
  const updateTargetPolicies = (patch: ProviderRoutingPolicyPatch) =>
    updatePolicy((targetSettings, environmentId) =>
      resolveTargetProviderRoutingPolicyPatch({
        settings: targetSettings,
        providers: providersFor(environmentId),
        patch,
      }),
    );

  const setMode = (defaultMode: ProviderRoutingMode) => updateTargetPolicies({ defaultMode });
  const setThreshold = (usageThresholdPercent: number | null) => {
    const patch = providerRoutingThresholdPatch(usageThresholdPercent);
    if (patch !== null) updatePolicy(patch);
  };
  const setDriverInstances = (
    driver: ProviderDriverKind,
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ) => {
    updateTargetPolicies({ instanceIdsByDriver: { [driver]: instanceIds } });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["providerRoutingPolicy"]}
      mixed={mixed}
      id="automatic-account-switching"
      title="Automatic account switching"
      description="Choose a pool of accounts. Hotlap uses the eligible account whose weekly limit resets first."
      status={
        policy.defaultMode === "auto" && !canEnableAuto
          ? policy.usageThresholdPercent === null
            ? "Choose a usage threshold before enabling automatic switching."
            : "Add at least two accounts for the same provider to switch automatically."
          : undefined
      }
      control={
        <Select
          value={mixed ? null : policy.defaultMode}
          onValueChange={(value) => {
            if (value === "fixed" || (value === "auto" && canEnableAuto)) setMode(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Default account switching mode">
            <SelectValue>
              {(value: string | null) =>
                value === "auto" ? "Auto" : value === "fixed" ? "Fixed" : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="fixed">Fixed</SelectItem>
            <SelectItem value="auto" disabled={!canEnableAuto}>
              Auto
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    >
      <div className="mt-3 grid gap-3 border-t border-border/50 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Switch at</p>
            <p className="text-xs text-muted-foreground">
              Usage percentage that triggers a switch.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NumberField
              value={policy.usageThresholdPercent}
              min={1}
              max={100}
              step={1}
              size="sm"
              className="w-28"
              onValueChange={setThreshold}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease account switching threshold" />
                <NumberFieldInput aria-label="Account switching usage threshold percentage" />
                <NumberFieldIncrement aria-label="Increase account switching threshold" />
              </NumberFieldGroup>
            </NumberField>
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        </div>
        {groupedOptions.size === 0 ? (
          <p className="text-xs text-muted-foreground">
            No signed-in Codex or Claude accounts are ready on every selected environment.
          </p>
        ) : (
          [...groupedOptions.entries()].map(([driver, entries]) => {
            const selected = policy.instanceIdsByDriver[driver] ?? [];
            const displayEntries = mergeProviderRoutingOptions(driver, entries, selected);
            return (
              <div key={driver} className="grid gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {DRIVER_LABELS[driver] ?? driver}
                </p>
                {displayEntries.map((entry) => {
                  const checked = selected.includes(entry.instanceId);
                  return (
                    <div
                      key={entry.instanceId}
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
                    >
                      <Checkbox
                        checked={checked}
                        aria-label={`Allow ${entry.displayName}`}
                        onCheckedChange={(enabled) =>
                          setDriverInstances(
                            driver,
                            toggleProviderRoutingInstance(
                              selected,
                              entry.instanceId,
                              enabled === true,
                            ),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {entry.displayName}
                        {entry.unavailable ? " (Unavailable)" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </SettingsRow>
  );
}
