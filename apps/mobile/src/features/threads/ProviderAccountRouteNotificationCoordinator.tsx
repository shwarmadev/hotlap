import {
  createProviderAccountRouteNotificationTracker,
  type ProviderAccountRouteNotification,
} from "@t3tools/client-runtime/provider-account-route-notifications";
import type { ProviderAccountRouteActivity } from "@t3tools/client-runtime/provider-account-route-notifications";
import * as Option from "effect/Option";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { parseActiveThreadPath } from "../keyboard/hardwareKeyboardCommands";
import { cn } from "../../lib/cn";
import { useEnvironmentThread } from "../../state/threads";
import { AppText as Text } from "../../components/AppText";

const ROUTE_BANNER_VISIBLE_MS = 5_000;
const EMPTY_ACTIVITIES: ReadonlyArray<ProviderAccountRouteActivity> = Object.freeze([]);

export function ProviderAccountRouteBanner(props: {
  readonly notification: ProviderAccountRouteNotification;
  readonly onDismiss: () => void;
  readonly topInset: number;
}) {
  const error = props.notification.kind === "error";
  return (
    <View
      className="absolute inset-x-0 top-0 z-50 items-center px-3"
      pointerEvents="box-none"
      style={{ paddingTop: props.topInset + 8 }}
    >
      <View
        accessibilityRole="alert"
        className={cn(
          "w-full max-w-xl flex-row items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg",
          error ? "border-danger-border bg-danger" : "border-border bg-card",
        )}
      >
        <View className="min-w-0 flex-1">
          <Text
            accessibilityLiveRegion="polite"
            className={cn(
              "font-t3-bold text-sm",
              error ? "text-danger-foreground" : "text-foreground",
            )}
          >
            {props.notification.title}
          </Text>
          {props.notification.description ? (
            <Text
              className={cn(
                "mt-0.5 text-xs",
                error ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {props.notification.description}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityLabel="Dismiss notification"
          accessibilityRole="button"
          className="rounded-full px-2 py-1"
          hitSlop={8}
          onPress={props.onDismiss}
        >
          <Text
            className={cn("text-xs", error ? "text-danger-foreground" : "text-foreground-muted")}
          >
            Dismiss
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function RouteBannerHost(props: {
  readonly notification: ProviderAccountRouteNotification;
  readonly onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const timer = setTimeout(props.onDismiss, ROUTE_BANNER_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [props.onDismiss]);
  return (
    <ProviderAccountRouteBanner
      notification={props.notification}
      onDismiss={props.onDismiss}
      topInset={insets.top}
    />
  );
}

/**
 * Observes the active thread's existing detail subscription. A global fan-out
 * would load every transcript because the shell stream does not carry durable
 * activities, so inactive threads intentionally keep timeline history only.
 */
export function ProviderAccountRouteNotificationCoordinator(props: { readonly pathname: string }) {
  const target = parseActiveThreadPath(props.pathname);
  const threadState = useEnvironmentThread(target?.environmentId ?? null, target?.threadId ?? null);
  const thread = Option.getOrNull(threadState.data);
  const [tracker] = useState(createProviderAccountRouteNotificationTracker);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [pending, setPending] = useState<ReadonlyArray<ProviderAccountRouteNotification>>([]);
  const threadKey =
    target === null ? null : `${String(target.environmentId)}:${String(target.threadId)}`;
  const activities =
    thread?.turnItems.flatMap((item) =>
      item.type === "system_notice" && item.hotlapActivity
        ? [
            {
              id: item.id,
              summary: item.message,
              kind: item.hotlapActivity.kind,
              payload: item.hotlapActivity.payload,
            },
          ]
        : [],
    ) ?? EMPTY_ACTIVITIES;
  const resolvedThreadId = thread?.thread.id ?? null;
  const detailResolved = threadState.status === "live" && resolvedThreadId === target?.threadId;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      setForeground(active);
      if (!active) setPending([]);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const observedThreadKey = threadKey !== null && detailResolved ? threadKey : null;
    const notifications = tracker.observe(
      observedThreadKey,
      observedThreadKey === null ? EMPTY_ACTIVITIES : activities,
      foreground,
    );
    // oxlint-disable-next-line react/set-state-in-effect -- Durable external activities enqueue transient native presentation.
    if (notifications.length > 0) setPending((current) => [...current, ...notifications]);
  }, [activities, detailResolved, foreground, threadKey, tracker]);

  const dismissCurrent = useCallback(() => setPending((items) => items.slice(1)), []);

  const current = pending[0];
  if (!foreground || current === undefined) return null;
  return (
    <RouteBannerHost key={current.activityId} notification={current} onDismiss={dismissCurrent} />
  );
}
