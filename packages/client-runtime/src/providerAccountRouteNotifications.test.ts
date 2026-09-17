import {
  EventId,
  type OrchestrationThreadActivity,
  PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createProviderAccountRouteNotificationTracker,
  providerAccountRouteFailureDescription,
} from "./providerAccountRouteNotifications.js";

function activity(
  id: string,
  kind: string,
  payload: unknown,
  summary = "Switched provider account",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: kind.endsWith("failed") ? "error" : "info",
    kind,
    summary,
    payload,
    turnId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
}

describe("provider account route notifications", () => {
  it("baselines history, then presents a new handoff once", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const historical = activity("route-old", "provider.account.routed", {
      providerName: "Codex",
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });
    const routed = activity("route-new", "provider.account.routed", {
      providerName: "Codex",
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread", [historical], true)).toEqual([]);
    expect(tracker.observe("env:thread", [historical, routed], true)).toEqual([
      {
        activityId: "route-new",
        kind: "success",
        title: "Switched Codex: Personal → Work",
        description: "Continuing this thread.",
      },
    ]);
    expect(tracker.observe("env:thread", [historical, routed], true)).toEqual([]);
  });

  it("consumes events received in the background without presenting them later", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const routed = activity("route-new", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    tracker.observe("env:thread", [], true);
    expect(tracker.observe("env:thread", [routed], false)).toEqual([]);
    expect(tracker.observe("env:thread", [routed], true)).toEqual([]);
  });

  it("keeps initial placement in the timeline and falls back safely for incomplete payloads", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    tracker.observe("env:thread", [], true);

    expect(
      tracker.observe(
        "env:thread",
        [
          activity("initial", "provider.account.routed", {
            initialPlacement: true,
            providerInstanceLabel: "Work",
          }),
          activity(
            "fallback",
            "provider.account.routed",
            {
              previousProviderInstanceId: "claude-personal",
              providerInstanceId: "claude-work",
            },
            "Account changed",
          ),
        ],
        true,
      ),
    ).toEqual([
      {
        activityId: "fallback",
        kind: "success",
        title: "Account changed",
        description: "Continuing this thread.",
      },
    ]);
  });

  it("presents route failures as errors with defensive detail parsing", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    tracker.observe("env:thread", [], true);

    expect(
      tracker.observe(
        "env:thread",
        [
          activity(
            "failed",
            "provider.account.route.failed",
            { detail: PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS.targetStartFailed },
            "Provider account switch failed",
          ),
        ],
        true,
      ),
    ).toEqual([
      {
        activityId: "failed",
        kind: "error",
        title: "Provider account switch failed",
        description: PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS.targetStartFailed,
      },
    ]);
  });

  it("replaces internal failure details with a generic description", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    tracker.observe("env:thread", [], true);
    const unsafeDetails = [
      "Error: spawn failed\n    at ensureSession (/Users/dev/t3/apps/server/src/provider.ts:12:3)",
      "C:/Users/dev/AppData/claude.json could not be read",
      "ENOENT:/Users/dev/.t3/userdata/secrets/claude.json",
      "Missing ~/.t3/userdata/secrets/claude.json",
      "Invalid API key sk-ant-api03-AbCdEf123_xyz-QQ",
      "ANTHROPIC_API_KEY=sk-ant-abc123 rejected",
      '{"error":{"type":"auth"},"token":"ghp_abcdef"}',
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      "Account alice@example.com is not signed in",
      "TypeError: Cannot read properties of undefined (reading x)",
      "SqlError: SQLITE_BUSY database is locked",
      "Work account could not authenticate.",
    ];

    const notifications = tracker.observe(
      "env:thread",
      unsafeDetails.map((detail, index) =>
        activity(
          `failed-${index}`,
          "provider.account.route.failed",
          { detail },
          "Provider account switch failed",
        ),
      ),
      true,
    );

    expect(notifications.map((notification) => notification.description)).toEqual(
      unsafeDetails.map(() => "The account switch could not be completed."),
    );
  });

  it("shows only the details a current server writes", () => {
    for (const detail of Object.values(PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS)) {
      expect(providerAccountRouteFailureDescription({ detail })).toBe(detail);
    }
    expect(providerAccountRouteFailureDescription({ detail: "   " })).toBe(
      "The account switch could not be completed.",
    );
    expect(providerAccountRouteFailureDescription(null)).toBe(
      "The account switch could not be completed.",
    );
  });

  it("baselines each active thread independently and survives reconnect snapshots", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const first = activity("route-a", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread-a", [first], true)).toEqual([]);
    expect(tracker.observe("env:thread-b", [first], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [first], true)).toEqual([]);
  });

  it("does not replay a route that happened while the thread was inactive or reconnecting", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const routed = activity("route-away", "provider.account.routed", {
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    });

    expect(tracker.observe("env:thread-a", [], true)).toEqual([]);
    expect(tracker.observe(null, [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [routed], true)).toEqual([]);
    expect(tracker.observe(null, [], true)).toEqual([]);
    expect(tracker.observe("env:thread-a", [routed], true)).toEqual([]);
  });

  it("does not present older route history when pagination prepends it", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const oldRoute = activity("route-old", "provider.account.routed", {
      previousProviderInstanceLabel: "First",
      providerInstanceLabel: "Second",
    });
    const latestActivity = activity("message-latest", "message.completed", {});

    expect(tracker.observe("env:thread", [latestActivity], true)).toEqual([]);
    expect(tracker.observe("env:thread", [oldRoute, latestActivity], true)).toEqual([]);
  });

  it("presents only the live append when pagination and a route arrive together", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const oldRoute = activity("route-old", "provider.account.routed", {
      previousProviderInstanceLabel: "First",
      providerInstanceLabel: "Second",
    });
    const anchor = activity("message-anchor", "message.completed", {});
    const liveRoute = activity("route-live", "provider.account.routed", {
      previousProviderInstanceLabel: "Second",
      providerInstanceLabel: "Third",
    });

    tracker.observe("env:thread", [anchor], true);
    expect(tracker.observe("env:thread", [oldRoute, anchor, liveRoute], true)).toEqual([
      {
        activityId: "route-live",
        kind: "success",
        title: "Switched Second → Third",
        description: "Continuing this thread.",
      },
    ]);
  });

  it("re-baselines when a capped snapshot replaces the previous tail", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const originalTail = activity("message-old-tail", "message.completed", {});
    const replacementRoute = activity("route-replacement", "provider.account.routed", {
      previousProviderInstanceLabel: "First",
      providerInstanceLabel: "Second",
    });

    tracker.observe("env:thread", [originalTail], true);
    expect(tracker.observe("env:thread", [replacementRoute], true)).toEqual([]);
  });

  it("re-baselines after the activity window temporarily disappears", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const originalTail = activity("message-tail", "message.completed", {});
    const restoredRoute = activity("route-restored", "provider.account.routed", {
      previousProviderInstanceLabel: "First",
      providerInstanceLabel: "Second",
    });

    tracker.observe("env:thread", [originalTail], true);
    tracker.observe("env:thread", [], true);
    expect(tracker.observe("env:thread", [originalTail, restoredRoute], true)).toEqual([]);
  });

  it("presents a duplicated appended route id at most once", () => {
    const tracker = createProviderAccountRouteNotificationTracker();
    const anchor = activity("message-anchor", "message.completed", {});
    const route = activity("route-duplicate", "provider.account.routed", {
      previousProviderInstanceLabel: "First",
      providerInstanceLabel: "Second",
    });

    tracker.observe("env:thread", [anchor], true);
    expect(tracker.observe("env:thread", [anchor, route, route], true)).toHaveLength(1);
  });
});
