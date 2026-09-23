import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "locale" }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { UsageLimitsByAccount } from "./UsageLimitsByAccount";

const now = Date.parse("2026-09-23T12:00:00.000Z");
const checkedAt = "2026-09-23T11:59:00.000Z";
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const session = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "primary",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: "2026-09-23T14:00:00.000Z",
});
const fableWeekly = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: "2026-09-26T12:00:00.000Z",
});

function lane(
  id: string,
  driver: ServerProvider["driver"],
  displayName: string,
  windows: ServerProviderUsageWindow[] | null,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver,
    displayName,
    enabled: true,
    installed: windows !== null,
    version: null,
    status: windows === null ? "warning" : "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...(windows ? { usageLimits: { checkedAt, windows } } : {}),
  };
}

function render(providers: ServerProvider[]): string {
  const presentations = new Map([
    [
      EnvironmentId.make("env-a"),
      { entry: { target: { label: "Laptop" } }, serverConfig: { providers } },
    ],
  ]);
  return renderToStaticMarkup(<UsageLimitsByAccount presentations={presentations} now={now} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const lanes = [
  lane("claude_personal", claude, "Claude · Personal", [session(35), fableWeekly(48)]),
  lane("claude_team", claude, "Claude · Team", null),
  lane("codex_personal", codex, "Codex · Personal", [session(12)]),
  lane("codex_team", codex, "Codex · Team", [session(88)]),
  lane("codex_agents", codex, "Codex · Agents", [session(3)]),
];

describe("UsageLimitsByAccount", () => {
  it("renders each account of one provider as its own row with its own values", () => {
    const text = render(lanes);
    expect(text).toContain("3 accounts");
    // Each row names its lane in full, followed by its own session figure. The
    // name's "·" cannot appear before the figure, so a match never spans rows.
    expect(text).toMatch(/Codex · Agents [^·]*?Session 97% left/);
    expect(text).toMatch(/Codex · Personal [^·]*?Session 88% left/);
    expect(text).toMatch(/Codex · Team [^·]*?Session 12% left/);
    expect(text).toMatch(/Claude · Personal [^·]*?Session 65% left [^·]*?Weekly · Fable 52% left/);
  });

  it("renders a configured lane with no limits as a no-usage row", () => {
    expect(render(lanes)).toMatch(/Claude · Team [^·]*?No usage reported yet/);
  });

  it("has no blended cross-account headline", () => {
    const text = render(lanes);
    // Mean of 97, 88 and 12: the old pooled figure.
    expect(text).not.toContain("66%");
    expect(text).not.toMatch(/\+\d+%/);
  });
});
