import { describe, expect, it, vi } from "vite-plus/test";
import { preserveBrowserInputFocus } from "./BrowserInputFocus.ts";

const setup = () => {
  const focus = vi.fn();
  const saved = { id: 7, isDestroyed: () => false, focus };
  let current: typeof saved | null = saved;
  let activeWindow = true;
  const dispatch = vi.fn(async () => undefined);
  const send = preserveBrowserInputFocus(
    dispatch,
    42,
    () => current,
    () => activeWindow,
  );
  return {
    focus,
    saved,
    send,
    dispatch,
    setCurrent: (value: typeof current) => {
      current = value;
    },
    leaveApp: () => {
      current = null;
      activeWindow = false;
    },
  };
};

describe("desktop browser input focus", () => {
  it("restores the previous renderer after the final click command", async () => {
    const state = setup();
    await state.send("Input.dispatchMouseEvent", { type: "mousePressed" }, undefined);
    expect(state.focus).not.toHaveBeenCalled();
    state.setCurrent({ ...state.saved, id: 42 });
    await state.send("Input.dispatchMouseEvent", { type: "mouseReleased" }, undefined);
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.focus.mock.invocationCallOrder[0]).toBeGreaterThan(
      state.dispatch.mock.invocationCallOrder.at(-1)!,
    );
  });
  it.each(["another renderer", "another app"])(
    "respects a user switching to %s",
    async (destination) => {
      const state = setup();
      await state.send("Input.dispatchMouseEvent", { type: "mousePressed" }, undefined);
      if (destination === "another app") state.leaveApp();
      else state.setCurrent({ ...state.saved, id: 9 });
      await state.send("Input.dispatchMouseEvent", { type: "mouseReleased" }, undefined);
      expect(state.focus).not.toHaveBeenCalled();
    },
  );
  it("restores focus when dispatch fails while preserving the original error", async () => {
    const state = setup();
    const error = new Error("CDP interrupted");
    state.dispatch.mockImplementationOnce(async () => {
      state.setCurrent({ ...state.saved, id: 42 });
      throw error;
    });
    await expect(
      state.send("Input.dispatchMouseEvent", { type: "mousePressed" }, "child-session"),
    ).rejects.toBe(error);
    expect(state.focus).toHaveBeenCalledOnce();
  });
  it("leaves a destroyed renderer alone", async () => {
    const state = setup();
    state.setCurrent({ ...state.saved, isDestroyed: () => true });
    await state.send("Input.dispatchMouseEvent", { type: "mousePressed" }, undefined);
    state.setCurrent({ ...state.saved, id: 42 });
    await state.send("Input.dispatchMouseEvent", { type: "mouseReleased" }, undefined);
    expect(state.focus).not.toHaveBeenCalled();
  });
});
