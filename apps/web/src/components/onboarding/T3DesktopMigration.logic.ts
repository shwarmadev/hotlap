import type {
  DesktopBridge,
  DesktopT3MigrationInspection,
  DesktopT3MigrationReason,
} from "@t3tools/contracts";

export type T3DesktopMigrationBridge = Required<
  Pick<
    DesktopBridge,
    "inspectT3DesktopMigration" | "dismissT3DesktopMigration" | "startT3DesktopMigration"
  >
>;

export function getT3DesktopMigrationBridge(
  bridge: DesktopBridge | undefined,
): T3DesktopMigrationBridge | undefined {
  if (
    !bridge?.inspectT3DesktopMigration ||
    !bridge.dismissT3DesktopMigration ||
    !bridge.startT3DesktopMigration
  ) {
    return undefined;
  }
  return bridge as T3DesktopMigrationBridge;
}

export function shouldOfferT3MigrationOnboarding(
  inspection: DesktopT3MigrationInspection,
): boolean {
  return (
    (inspection.status === "ready" || inspection.status === "blocked") && !inspection.dismissed
  );
}

const REASON_MESSAGES = {
  "unsupported-platform": "Switching from T3 Code is currently available on macOS.",
  "development-build": "Use a packaged Hotlap app to switch from T3 Code.",
  "custom-home": "The switch supports the default T3 Code and Hotlap data locations only.",
  "source-missing": "No T3 Code workspace was found on this Mac.",
  "source-running": "Quit T3 Code completely, then try again. Hotlap will never close it for you.",
  "source-busy":
    "Finish running turns, approvals, and questions in T3 Code, then quit it and try again.",
  "schema-unsupported":
    "This T3 Code workspace uses a newer or incompatible database and cannot be switched safely.",
  "destination-changed":
    "Hotlap data changed during preparation. Review the latest state and try again.",
  "recovery-required": "Hotlap must recover an earlier switch attempt before continuing.",
  "unknown-source-entry":
    "The T3 Code workspace contains data this Hotlap version cannot classify safely.",
} satisfies Record<DesktopT3MigrationReason, string>;

export function migrationReasonMessage(reason: DesktopT3MigrationReason): string {
  return REASON_MESSAGES[reason];
}
