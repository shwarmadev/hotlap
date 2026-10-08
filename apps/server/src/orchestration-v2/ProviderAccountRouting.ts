import {
  PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isProviderAccountConfirmedUnusable,
  selectAutomaticProviderAccount,
} from "../provider/providerAccountRouting.ts";

export type AutomaticRoutingPlan =
  | { readonly type: "none" }
  | { readonly type: "blocked"; readonly detail: string; readonly disableAuto: boolean }
  | { readonly type: "route"; readonly modelSelection: ModelSelection; readonly reason: string };

/** Automatic consent belongs to a project; a server default must never authorize an account switch. */
export function automaticRoutingPlan(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly modelSelection: ModelSelection;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly allow: boolean;
  readonly rejectedInstanceIds?: ReadonlyArray<string>;
}): AutomaticRoutingPlan {
  const { projection, modelSelection, nowMs } = input;
  if (
    !input.allow ||
    projection.thread.providerRoutingMode !== "auto" ||
    modelSelection.instanceId !== projection.thread.modelSelection.instanceId ||
    projection.runs.some((run) =>
      ["queued", "starting", "running", "waiting"].includes(run.status),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0)
  )
    return { type: "none" };
  const resolved = resolveProjectSettings(input.settings, projection.thread.projectId);
  if (resolved.sources.providerRoutingPolicy !== "project") return { type: "none" };
  const current = input.providers.find(
    (provider) => provider.instanceId === modelSelection.instanceId,
  );
  if (current === undefined) return { type: "none" };
  const policy = resolved.settings.providerRoutingPolicy;
  const instanceIds = policy.instanceIdsByDriver[current.driver] ?? [];
  const maxUsageAgeMs = Math.max(
    10 * 60_000,
    Duration.toMillis(
      resolveServerBackgroundActivitySettings(input.settings).providerHealthRefreshInterval,
    ) * 2,
  );
  const unusable =
    input.rejectedInstanceIds?.includes(current.instanceId) === true ||
    isProviderAccountConfirmedUnusable(current, { nowMs, maxUsageAgeMs });
  if (
    policy.usageThresholdPercent === null ||
    new Set(instanceIds).size < 2 ||
    !instanceIds.includes(current.instanceId)
  )
    return unusable
      ? {
          type: "blocked",
          detail: PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS.notConfigured,
          disableAuto: true,
        }
      : { type: "none" };
  const decision = selectAutomaticProviderAccount({
    routingMode: "auto",
    instanceIds,
    usageThresholdPercent: policy.usageThresholdPercent,
    threadHasStarted:
      projection.runs.some((run) => run.startedAt !== null) ||
      projection.thread.historyOrigin === "v1_import",
    modelSelection,
    providers: input.providers,
    nowMs,
    maxUsageAgeMs,
    limitedInstanceIds: input.rejectedInstanceIds,
  });
  const target = decision?.targetInstanceIds[0];
  if (target === undefined)
    return unusable
      ? {
          type: "blocked",
          detail: PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS.noEligibleAccount,
          disableAuto: false,
        }
      : { type: "none" };
  return {
    type: "route",
    modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make(target) },
    reason: decision!.reason,
  };
}
