import type {
  DesktopT3MigrationInspection,
  DesktopT3MigrationStartResult,
} from "@t3tools/contracts";
import { act, type ReactTestRenderer, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { T3DesktopMigrationBridge } from "./T3DesktopMigration.logic";
import { T3DesktopMigrationFlow } from "./T3DesktopMigration";

const readyInspection = (destinationHasData = false): DesktopT3MigrationInspection => ({
  status: "ready",
  dismissed: false,
  summary: {
    projectCount: 9,
    threadCount: 184,
    destinationHasData,
    pairingTransfer: "preserved",
  },
});

function makeBridge(inspection: DesktopT3MigrationInspection) {
  return {
    inspectT3DesktopMigration: vi.fn().mockResolvedValue(inspection),
    dismissT3DesktopMigration: vi.fn().mockResolvedValue(undefined),
    startT3DesktopMigration: vi.fn().mockResolvedValue({
      status: "completed",
      pairingTransfer: "preserved",
    } satisfies DesktopT3MigrationStartResult),
  } satisfies T3DesktopMigrationBridge;
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function renderFlow(
  bridge: T3DesktopMigrationBridge,
  options: {
    readonly surface?: "onboarding" | "settings";
    readonly onContinue?: () => void;
    readonly onUnavailable?: () => void;
  } = {},
) {
  const onContinue = options.onContinue ?? vi.fn();
  await act(async () => {
    renderer = create(
      <T3DesktopMigrationFlow
        bridge={bridge}
        surface={options.surface ?? "onboarding"}
        onContinue={onContinue}
        {...(options.onUnavailable ? { onUnavailable: options.onUnavailable } : {})}
      />,
    );
  });
  return { root: renderer!.root, onContinue };
}

describe("T3DesktopMigrationFlow", () => {
  it("shows discovered durable data and dismisses without starting", async () => {
    const bridge = makeBridge(readyInspection());
    const { root, onContinue } = await renderFlow(bridge);

    expect(root.findByProps({ "aria-label": "Migration summary" })).toBeDefined();
    expect(root.findAllByType("dd").map((node) => node.children.join(""))).toEqual([
      "9",
      "184",
      "This Mac",
    ]);

    await act(async () => root.findByProps({ "aria-label": "Not now" }).props.onClick());
    expect(bridge.dismissT3DesktopMigration).toHaveBeenCalledOnce();
    expect(bridge.startT3DesktopMigration).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("requires explicit backup-and-replace confirmation for existing Hotlap data", async () => {
    const bridge = makeBridge(readyInspection(true));
    const { root } = await renderFlow(bridge);

    await act(async () => root.findByProps({ "aria-label": "Switch to Hotlap" }).props.onClick());
    expect(bridge.startT3DesktopMigration).not.toHaveBeenCalled();
    expect(root.findByProps({ role: "alert" }).findByType("h1").children.join("")).toContain(
      "Hotlap already has data",
    );

    await act(async () =>
      root.findByProps({ "aria-label": "Back up and replace" }).props.onClick(),
    );
    expect(bridge.startT3DesktopMigration).toHaveBeenCalledWith({ replaceExisting: true });
    expect(root.findByProps({ role: "status" }).findByType("h1").children.join("")).toContain(
      "Switch complete",
    );
  });

  it("keeps progress accessible and surfaces safe failures", async () => {
    let finish: ((result: DesktopT3MigrationStartResult) => void) | undefined;
    const bridge = makeBridge(readyInspection());
    bridge.startT3DesktopMigration.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { root } = await renderFlow(bridge);

    await act(() => root.findByProps({ "aria-label": "Switch to Hotlap" }).props.onClick());
    expect(root.findByProps({ role: "status" }).children.join("")).toContain("Switching");
    expect(root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);

    await act(async () => {
      finish?.({
        status: "error",
        message: "Hotlap could not prepare the switch. Your T3 Code data was not changed.",
      });
    });
    expect(root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Your T3 Code data was not changed",
    );
  });

  it("skips unavailable onboarding and omits its dismissal action from Settings", async () => {
    const onUnavailable = vi.fn();
    await renderFlow(makeBridge({ status: "unavailable", reason: "source-missing" }), {
      onUnavailable,
    });
    expect(onUnavailable).toHaveBeenCalledOnce();

    await act(() => renderer?.unmount());
    const { root } = await renderFlow(makeBridge(readyInspection()), { surface: "settings" });
    expect(root.findAllByProps({ "aria-label": "Not now" })).toHaveLength(0);
  });
});
