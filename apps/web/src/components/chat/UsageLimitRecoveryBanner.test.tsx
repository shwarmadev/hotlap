import { RunId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
});

it("does not offer an unsupported manual recovery for an unknown reset", () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const runId = RunId.make("limited-run");
  const banner = usageLimitRecoveryBannerItem({
    runId,
    resetAt: null,
    stoppedAt: "2026-10-08T00:00:00.000Z",
    recovery: null,
    snoozedUntil: null,
    onChange,
  });
  expect(banner.actions).toBeNull();
  expect(banner.description).toContain("Retry the thread manually");
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps cancellation available throughout an unknown-reset retry cycle", async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const runId = RunId.make("limited-run");
  const banner = usageLimitRecoveryBannerItem({
    runId,
    resetAt: null,
    stoppedAt: "2026-10-08T00:00:00.000Z",
    recovery: { runId, resetAt: null, autoResume: true },
    snoozedUntil: null,
    onChange,
  });
  expect(banner.title).toBe("Waiting for usage limit");
  await act(() => {
    renderer = create(<>{banner.actions}</>);
  });
  const buttons = renderer!.root.findAllByType("button");
  expect(buttons).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Cancel auto-resume");
  await act(() => buttons[0]!.props.onClick());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ runId, resetAt: null, autoResume: false });
});
