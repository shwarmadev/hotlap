import {
  type OrchestrationThreadActivity,
  PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS,
} from "@t3tools/contracts";

export interface ProviderAccountRouteNotification {
  readonly activityId: string;
  readonly kind: "success" | "error";
  readonly title: string;
  readonly description?: string;
}

export interface ProviderAccountRouteNotificationTracker {
  readonly observe: (
    threadKey: string | null,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
    foreground: boolean,
  ) => ReadonlyArray<ProviderAccountRouteNotification>;
}

const ROUTE_KINDS = new Set(["provider.account.routed", "provider.account.route.failed"]);

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringValue(payload: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

const GENERIC_ROUTE_FAILURE_DESCRIPTION = "The account switch could not be completed.";
const ALLOWED_ROUTE_FAILURE_DETAILS = new Set<string>(
  Object.values(PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS),
);

/**
 * Route failure details are user-facing, so only the fixed set a current server
 * writes is shown. Anything else (raw causes from older servers, provider error
 * text persisted in old activities) becomes a generic description. Used by every
 * surface that renders `provider.account.route.failed`.
 */
export function providerAccountRouteFailureDescription(payload: unknown): string {
  const detail = stringValue(record(payload), ["detail", "error", "message"]);
  return detail !== null && ALLOWED_ROUTE_FAILURE_DETAILS.has(detail)
    ? detail
    : GENERIC_ROUTE_FAILURE_DESCRIPTION;
}

function present(activity: OrchestrationThreadActivity): ProviderAccountRouteNotification | null {
  const payload = record(activity.payload);
  if (activity.kind === "provider.account.route.failed") {
    return {
      activityId: activity.id,
      kind: "error",
      title: activity.summary,
      description: providerAccountRouteFailureDescription(payload),
    };
  }

  const provider = stringValue(payload, ["providerName", "providerLabel", "provider"]);
  const previous = stringValue(payload, [
    "previousProviderInstanceLabel",
    "previousAccountLabel",
    "previousAccountName",
  ]);
  const target = stringValue(payload, ["providerInstanceLabel", "accountLabel", "accountName"]);
  const initialPlacement =
    payload.initialPlacement === true || payload.reason === "initial-placement";

  // Initial placement is recorded in the timeline, but is not a completed
  // cross-account handoff and may precede the provider's first native auth response.
  if (initialPlacement) return null;
  if (previous !== null && target !== null) {
    return {
      activityId: activity.id,
      kind: "success",
      title: `Switched${provider === null ? "" : ` ${provider}:`} ${previous} → ${target}`,
      description: "Continuing this thread.",
    };
  }
  return {
    activityId: activity.id,
    kind: "success",
    title: activity.summary,
    description: "Continuing this thread.",
  };
}

/**
 * Tracks durable route activities for active thread detail streams. The first
 * observation of each thread is history, and background observations are
 * consumed without presentation so hydration, reconnects, and foregrounding
 * never replay old notifications.
 */
export function createProviderAccountRouteNotificationTracker(): ProviderAccountRouteNotificationTracker {
  const seenActivityIds = new Set<string>();
  let activeThreadKey: string | null = null;
  let tailActivityId: string | null = null;
  let rebaselineNextNonEmpty = false;

  const baseline = (
    threadKey: string | null,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ) => {
    activeThreadKey = threadKey;
    tailActivityId = activities.at(-1)?.id ?? null;
    rebaselineNextNonEmpty = false;
    for (const activity of activities) {
      if (ROUTE_KINDS.has(activity.kind)) seenActivityIds.add(activity.id);
    }
  };

  return {
    observe(threadKey, activities, foreground) {
      if (threadKey === null) {
        baseline(null, activities);
        return [];
      }
      if (activeThreadKey !== threadKey || !foreground) {
        baseline(threadKey, activities);
        return [];
      }

      if (activities.length === 0) {
        rebaselineNextNonEmpty = tailActivityId !== null;
        tailActivityId = null;
        return [];
      }
      if (rebaselineNextNonEmpty) {
        baseline(threadKey, activities);
        return [];
      }

      const tailIndex =
        tailActivityId === null
          ? -1
          : activities.findIndex((activity) => activity.id === tailActivityId);
      if (tailActivityId !== null && tailIndex === -1) {
        baseline(threadKey, activities);
        return [];
      }

      const notifications: ProviderAccountRouteNotification[] = [];
      for (const activity of activities.slice(tailIndex + 1)) {
        if (!ROUTE_KINDS.has(activity.kind)) continue;
        if (seenActivityIds.has(activity.id)) continue;
        seenActivityIds.add(activity.id);
        const notification = present(activity);
        if (notification !== null) notifications.push(notification);
      }
      tailActivityId = activities.at(-1)?.id ?? null;
      return notifications;
    },
  };
}
