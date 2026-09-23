import { renderToStaticMarkup } from "react-dom/server";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ revealSensitiveText: false }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: Pick<ClientSettings, "revealSensitiveText">) => T) =>
    selector({ revealSensitiveText: state.revealSensitiveText }),
}));

import { RedactedSensitiveText } from "./RedactedSensitiveText";

const EMAIL = "finlay@example.com";

function render(): string {
  return renderToStaticMarkup(
    <RedactedSensitiveText
      value={EMAIL}
      ariaLabel="Account email"
      revealTooltip="Reveal email"
      hideTooltip="Hide email"
    />,
  );
}

describe("RedactedSensitiveText", () => {
  beforeEach(() => {
    state.revealSensitiveText = false;
  });

  it("redacts the value while the show-account-emails setting is off", () => {
    expect(render()).not.toContain(EMAIL);
  });

  it("renders the plain value when the show-account-emails setting is on", () => {
    state.revealSensitiveText = true;
    expect(render()).toContain(EMAIL);
  });
});
