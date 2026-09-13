import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  getT3DesktopMigrationBridge,
  migrationReasonMessage,
  shouldOfferT3MigrationOnboarding,
} from "./T3DesktopMigration.logic";

describe("T3 desktop migration presentation", () => {
  it("requires the complete optional bridge capability", () => {
    expect(getT3DesktopMigrationBridge(undefined)).toBeUndefined();
    expect(
      getT3DesktopMigrationBridge({
        inspectT3DesktopMigration: vi.fn(),
        dismissT3DesktopMigration: vi.fn(),
      } as unknown as DesktopBridge),
    ).toBeUndefined();

    const bridge = {
      inspectT3DesktopMigration: vi.fn(),
      dismissT3DesktopMigration: vi.fn(),
      startT3DesktopMigration: vi.fn(),
    } as unknown as DesktopBridge;
    expect(getT3DesktopMigrationBridge(bridge)).toBeDefined();
  });

  it("offers onboarding only for actionable, non-dismissed inspections", () => {
    expect(
      shouldOfferT3MigrationOnboarding({
        status: "ready",
        dismissed: false,
        summary: {
          projectCount: 2,
          threadCount: 12,
          destinationHasData: false,
          pairingTransfer: "preserved",
        },
      }),
    ).toBe(true);
    expect(
      shouldOfferT3MigrationOnboarding({
        status: "blocked",
        reason: "source-running",
        dismissed: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferT3MigrationOnboarding({
        status: "unavailable",
        reason: "source-missing",
      }),
    ).toBe(false);
    expect(
      shouldOfferT3MigrationOnboarding({
        status: "completed",
        pairingTransfer: "preserved",
      }),
    ).toBe(false);
  });

  it("turns block reasons into safe, actionable copy", () => {
    expect(migrationReasonMessage("source-running")).toContain("Quit T3 Code");
    expect(migrationReasonMessage("source-busy")).toContain("running turns");
    expect(migrationReasonMessage("schema-unsupported")).toContain("newer");
  });
});
