import type { CdpRelayTarget } from "./CdpRelay.ts";

type FocusedContents = Pick<Electron.WebContents, "id" | "isDestroyed" | "focus">;

/** CDP mouse input focuses a guest renderer, even when its tab is hidden. */
export const preserveBrowserInputFocus = (
  send: CdpRelayTarget["send"],
  guestId: number,
  getFocusedContents: () => FocusedContents | null,
  hasFocusedWindow: () => boolean,
): CdpRelayTarget["send"] => {
  let previous: FocusedContents | null = null;
  const restore = () => {
    const saved = previous;
    previous = null;
    if (!saved || saved.id === guestId || saved.isDestroyed()) return;
    try {
      const current = getFocusedContents();
      // A newer renderer selection or switching apps takes precedence.
      if (current && current.id !== guestId && current.id !== saved.id) return;
      if (!current && !hasFocusedWindow()) return;
      saved.focus();
    } catch {
      // Closing a renderer concurrently must not fail the completed browser action.
    }
  };
  return async (method, params, sessionId) => {
    const mouseInput = method === "Input.dispatchMouseEvent";
    if (mouseInput && params["type"] === "mousePressed") previous = getFocusedContents();
    try {
      return await send(method, params, sessionId);
    } catch (error) {
      if (mouseInput) restore();
      throw error;
    } finally {
      if (mouseInput && params["type"] === "mouseReleased") restore();
    }
  };
};
