import { EventId } from "@t3tools/contracts";
import type { ProviderAccountRouteActivity } from "@t3tools/client-runtime/provider-account-route-notifications";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  activities: [] as ProviderAccountRouteActivity[],
  add: vi.fn(),
  visible: true,
  focused: true,
  status: "live" as "live" | "synchronizing",
  documentListeners: new Map<string, Set<() => void>>(),
  windowListeners: new Map<string, Set<() => void>>(),
}));

function addListener(listeners: Map<string, Set<() => void>>, type: string, listener: () => void) {
  const current = listeners.get(type) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(type, current);
}

function removeListener(
  listeners: Map<string, Set<() => void>>,
  type: string,
  listener: () => void,
) {
  listeners.get(type)?.delete(listener);
}

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ environmentId: "env-1", threadId: "thread-1" }),
}));
vi.mock("../state/entities", () => ({
  useThreadProjection: () => ({
    projection: {
      turnItems: state.activities.map((activity) => ({
        id: activity.id,
        type: "system_notice",
        message: activity.summary,
        hotlapActivity: { kind: activity.kind, payload: activity.payload },
      })),
    },
  }),
  useThreadStatus: () => state.status,
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: state.add },
}));

import { ProviderAccountRouteNotificationCoordinator } from "./ProviderAccountRouteNotificationCoordinator";

function routed(id: string): ProviderAccountRouteActivity {
  return {
    id: EventId.make(id),
    kind: "provider.account.routed",
    summary: "Switched provider account",
    payload: {
      providerName: "Codex",
      previousProviderInstanceLabel: "Personal",
      providerInstanceLabel: "Work",
    },
  };
}

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ProviderAccountRouteNotificationCoordinator />);
    else renderer = create(<ProviderAccountRouteNotificationCoordinator />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.activities = [];
  state.visible = true;
  state.focused = true;
  state.status = "live";
  state.documentListeners.clear();
  state.windowListeners.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible ? "visible" : "hidden";
    },
    hasFocus: () => state.focused,
    addEventListener: (type: string, listener: () => void) =>
      addListener(state.documentListeners, type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      removeListener(state.documentListeners, type, listener),
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) =>
      addListener(state.windowListeners, type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      removeListener(state.windowListeners, type, listener),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("provider account route notification coordinator", () => {
  it("turns a new durable route activity into one five-second toast", async () => {
    await render();
    state.activities = [routed("route-1")];
    await render();
    await render();

    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledWith({
      type: "success",
      title: "Switched Codex: Personal → Work",
      description: "Continuing this thread.",
      data: { dismissAfterVisibleMs: 5_000, hideCopyButton: true },
    });
  });

  it("does not replay a route received while the page was hidden", async () => {
    await render();
    await act(() => {
      state.visible = false;
      state.focused = false;
      for (const listener of state.documentListeners.get("visibilitychange") ?? []) listener();
    });
    state.activities = [routed("route-hidden")];
    await render();
    await act(() => {
      state.visible = true;
      state.focused = true;
      for (const listener of state.documentListeners.get("visibilitychange") ?? []) listener();
    });
    await render();

    expect(state.add).not.toHaveBeenCalled();
  });

  it("baselines history only after the thread detail finishes synchronizing", async () => {
    state.status = "synchronizing";
    await render();
    state.activities = [routed("route-history")];
    await render();
    state.status = "live";
    await render();

    expect(state.add).not.toHaveBeenCalled();

    state.activities = [...state.activities, routed("route-live")];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
  });
});
