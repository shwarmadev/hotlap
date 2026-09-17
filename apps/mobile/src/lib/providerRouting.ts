import type {
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInstanceId,
  ProviderRoutingMode,
  ServerProvider,
} from "@t3tools/contracts";

const ROUTABLE_DRIVERS = new Set(["codex", "claudeAgent"]);

function isRunnableRoutingProvider(provider: ServerProvider): boolean {
  return (
    ROUTABLE_DRIVERS.has(provider.driver) &&
    provider.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status === "authenticated" &&
    provider.availability !== "unavailable"
  );
}

export function canEnableProviderRoutingAuto(
  providers: ReadonlyArray<ServerProvider>,
  instanceIdsByDriver: Readonly<Record<string, ReadonlyArray<ProviderInstanceId>>>,
  usageThresholdPercent: number | null,
  selectedInstanceId: ProviderInstanceId,
): boolean {
  if (
    usageThresholdPercent === null ||
    !Number.isInteger(usageThresholdPercent) ||
    usageThresholdPercent < 1 ||
    usageThresholdPercent > 100
  ) {
    return false;
  }
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === selectedInstanceId && isRunnableRoutingProvider(provider),
  );
  if (!selectedProvider) return false;

  const runnableIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.driver === selectedProvider.driver && isRunnableRoutingProvider(provider),
      )
      .map((provider) => provider.instanceId),
  );
  const configuredIds = instanceIdsByDriver[selectedProvider.driver] ?? [];
  return (
    configuredIds.includes(selectedProvider.instanceId) &&
    new Set(configuredIds.filter((instanceId) => runnableIds.has(instanceId))).size >= 2
  );
}

export function routingModeAfterManualModelSelection(
  currentMode: ProviderRoutingMode,
  currentInstanceId: ProviderInstanceId,
  nextInstanceId: ProviderInstanceId,
): ProviderRoutingMode {
  return currentMode === "auto" && currentInstanceId !== nextInstanceId ? "fixed" : currentMode;
}

/**
 * Claude only picks an account before its first turn, so the server pins
 * started Claude threads to Fixed. A first send that never became a turn
 * leaves Auto available.
 */
export function isProviderAccountLocked(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session" | "modelSelection">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): boolean {
  if (thread.latestTurn === null) return false;
  const driver =
    providers.find((provider) => provider.instanceId === thread.modelSelection.instanceId)
      ?.driver ?? thread.session?.providerName;
  return driver === "claudeAgent";
}

export function resolveProviderRoutingModeForSubmission(input: {
  readonly draftMode?: ProviderRoutingMode;
  readonly authoritativeMode: ProviderRoutingMode;
  readonly authoritativeInstanceId: ProviderInstanceId;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly accountLocked: boolean;
}): ProviderRoutingMode {
  if (input.accountLocked) return "fixed";
  return (
    input.draftMode ??
    routingModeAfterManualModelSelection(
      input.authoritativeMode,
      input.authoritativeInstanceId,
      input.selectedInstanceId,
    )
  );
}

/**
 * Whether a thread's routing-mode draft intent should give way to the server's
 * mode. The intent only matters while this client's save is in flight; the
 * save's own result clears it once settled, whatever mode the server kept.
 * `saveStatus` is "none" for a leftover intent (e.g. restored from the outbox),
 * which clears once the server shows the same mode.
 */
export function shouldClearProviderRoutingIntent(input: {
  readonly saveStatus: "none" | "pending";
  readonly intendedMode: ProviderRoutingMode | undefined;
  readonly authoritativeMode: ProviderRoutingMode;
  readonly accountLocked: boolean;
}): boolean {
  if (input.intendedMode === undefined) return false;
  if (input.accountLocked) return true;
  return input.saveStatus === "none" && input.intendedMode === input.authoritativeMode;
}

export function eligibleProjectDefaultProviderRoutingMode(
  configuredMode: ProviderRoutingMode,
  canEnableAuto: boolean,
): ProviderRoutingMode {
  return configuredMode === "auto" && !canEnableAuto ? "fixed" : configuredMode;
}

export function resolveNewTaskProviderRoutingMode(input: {
  /** Null means a new task; undefined means a legacy queued task without the field. */
  readonly editingMode: ProviderRoutingMode | null | undefined;
  readonly projectDefault: ProviderRoutingMode;
}): ProviderRoutingMode {
  return input.editingMode === null ? input.projectDefault : (input.editingMode ?? "fixed");
}

export function providerAccountRoutingConsentForSubmission(input: {
  readonly editingConsent: boolean | null;
  readonly providerRoutingMode: ProviderRoutingMode;
  readonly supported: boolean;
}): {
  readonly allowProviderAccountRouting?: true;
} {
  return input.supported && input.providerRoutingMode === "auto" && input.editingConsent !== false
    ? { allowProviderAccountRouting: true }
    : {};
}

export function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function reconcileDraftModelSelectionAfterAutomaticRoute(input: {
  readonly providerRoutingMode: ProviderRoutingMode;
  readonly previousThreadSelection: ModelSelection;
  readonly currentThreadSelection: ModelSelection;
  readonly draftSelection?: ModelSelection;
  readonly draftSelectionIsExplicit?: boolean;
}): ModelSelection | undefined {
  if (
    input.providerRoutingMode === "auto" &&
    input.draftSelection !== undefined &&
    input.draftSelectionIsExplicit !== true &&
    !modelSelectionsMatch(input.previousThreadSelection, input.currentThreadSelection) &&
    modelSelectionsMatch(input.draftSelection, input.previousThreadSelection)
  ) {
    return input.currentThreadSelection;
  }
  return input.draftSelection;
}
