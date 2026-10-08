import { createProviderAccountRouteNotificationTracker } from "@t3tools/client-runtime/provider-account-route-notifications";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useThreadProjection, useThreadStatus } from "../state/entities";
import { stackedThreadToast, toastManager } from "./ui/toast";

const ROUTE_TOAST_VISIBLE_MS = 5_000;
const EMPTY_ACTIVITIES = Object.freeze([]);

/**
 * Observes the active thread's existing detail subscription. There is no
 * lightweight global activity feed, so this deliberately avoids subscribing
 * to every thread (and loading every transcript) just to discover route events.
 */
export function ProviderAccountRouteNotificationCoordinator() {
  const params = useParams({ strict: false });
  const environmentId = typeof params.environmentId === "string" ? params.environmentId : null;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const thread = useThreadProjection(
    environmentId === null || threadId === null
      ? null
      : {
          environmentId: EnvironmentId.make(environmentId),
          threadId: ThreadId.make(threadId),
        },
  );
  const threadStatus = useThreadStatus(
    environmentId === null || threadId === null
      ? null
      : {
          environmentId: EnvironmentId.make(environmentId),
          threadId: ThreadId.make(threadId),
        },
  );
  const [tracker] = useState(createProviderAccountRouteNotificationTracker);
  const [foreground, setForeground] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const threadKey =
    environmentId === null || threadId === null ? null : `${environmentId}:${threadId}`;
  const activities =
    thread?.projection.turnItems.flatMap((item) =>
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
  const detailResolved = thread !== null && threadStatus === "live";

  useEffect(() => {
    const updateForeground = () =>
      setForeground(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", updateForeground);
    return () => {
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", updateForeground);
    };
  }, []);

  useEffect(() => {
    const observedThreadKey = threadKey !== null && detailResolved ? threadKey : null;
    for (const notification of tracker.observe(
      observedThreadKey,
      observedThreadKey === null ? EMPTY_ACTIVITIES : activities,
      foreground,
    )) {
      toastManager.add(
        stackedThreadToast({
          type: notification.kind,
          title: notification.title,
          ...(notification.description === undefined
            ? {}
            : { description: notification.description }),
          data: {
            dismissAfterVisibleMs: ROUTE_TOAST_VISIBLE_MS,
            hideCopyButton: true,
          },
        }),
      );
    }
  }, [activities, detailResolved, foreground, threadKey, tracker]);

  return null;
}
