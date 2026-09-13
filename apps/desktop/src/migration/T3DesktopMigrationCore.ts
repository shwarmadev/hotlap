// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- This desktop migration boundary needs atomic filesystem moves, SQLite inspection, and durable wall-clock receipts.
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { snapshotSqliteDatabase } from "@t3tools/shared/sqliteSnapshot";
import * as Effect from "effect/Effect";

export interface T3DesktopMigrationPaths {
  readonly sourceBaseDir: string;
  readonly sourceStateDir: string;
  readonly destinationBaseDir: string;
  readonly destinationStateDir: string;
  readonly migrationDir: string;
}

export type T3DesktopMigrationBlockedReason =
  | "unsupported-platform"
  | "development-build"
  | "custom-home"
  | "source-missing"
  | "source-running"
  | "source-busy"
  | "schema-unsupported"
  | "destination-changed"
  | "recovery-required"
  | "unknown-source-entry";

export interface T3DesktopMigrationSummary {
  readonly projectCount: number;
  readonly threadCount: number;
  readonly destinationHasData: boolean;
  readonly pairingTransfer: "preserved" | "re-pair-required";
}

export type T3DesktopMigrationInspection =
  | ({ readonly status: "ready" } & T3DesktopMigrationSummary)
  | {
      readonly status: "blocked";
      readonly reason: T3DesktopMigrationBlockedReason;
      readonly message?: string;
    }
  | { readonly status: "unavailable"; readonly reason: T3DesktopMigrationBlockedReason }
  | {
      readonly status: "completed";
      readonly pairingTransfer: T3DesktopMigrationSummary["pairingTransfer"];
    };

export type T3DesktopMigrationResult =
  | {
      readonly status: "completed";
      readonly pairingTransfer: T3DesktopMigrationSummary["pairingTransfer"];
    }
  | { readonly status: "blocked"; readonly reason: T3DesktopMigrationBlockedReason }
  | { readonly status: "failed"; readonly message: string };

export interface T3DesktopProcessProbe {
  readonly isPidAlive: (pid: number) => boolean;
  readonly isT3DesktopRunning: () => Promise<boolean>;
}

export interface T3DesktopMigrationHooks {
  /** Must resolve only after the captured Hotlap backend process and restart fiber are gone. */
  readonly stopDestinationBackend: () => Promise<void>;
  /** Must prove readiness, environment identity, bootstrap auth, and one initial snapshot read. */
  readonly startAndValidateDestinationBackend: () => Promise<void>;
  readonly reloadDestinationSettings: () => Promise<void>;
  readonly restartPreviousDestinationBackend: () => Promise<void>;
}

interface InspectInput {
  readonly paths: T3DesktopMigrationPaths;
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly usesDefaultDestinationHome: boolean;
  readonly processProbe: T3DesktopProcessProbe;
  readonly migrationManifest: ReadonlyArray<readonly [id: number, name: string]>;
}

interface MigrateInput {
  readonly paths: T3DesktopMigrationPaths;
  readonly processProbe: T3DesktopProcessProbe;
  readonly migrationManifest: ReadonlyArray<readonly [id: number, name: string]>;
  readonly replaceExisting: boolean;
  readonly hooks: T3DesktopMigrationHooks;
  readonly now?: () => Date;
  readonly makeRunId?: () => string;
}

type JournalPhase =
  | "prepared"
  | "source-quarantined"
  | "destination-stopped"
  | "destination-backed-up"
  | "destination-activated";

interface MigrationJournal {
  readonly version: 1;
  readonly runId: string;
  readonly phase: JournalPhase;
  readonly sourceBackup: string;
  readonly destinationBackup: string;
  readonly stageDir: string;
}

const COPIED_FILES = new Set([
  "client-settings.json",
  "desktop-settings.json",
  "environment-id",
  "keybindings.json",
  "settings.json",
]);
const COPIED_DIRECTORIES = new Set([
  "attachments",
  "browser-artifacts",
  "device",
  "providers",
  "themes",
]);
const EXCLUDED_ENTRIES = new Set([
  "anonymous-id",
  "connection-catalog.json",
  "logs",
  "model-manifest.json",
  "saved-environments.json",
  "server-runtime.json",
  "snap-shots",
  "state.sqlite-shm",
  "state.sqlite-wal",
  "usage-model-rates.json",
  "usage-scan-cache.json",
]);
const ALLOWED_SECRET_NAMES = [
  /^server-signing-key\.bin$/u,
  /^asset-access-signing-key\.bin$/u,
  /^provider-env-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.bin$/u,
  /^usage-limit-source-[A-Za-z0-9_-]+\.bin$/u,
];
const JOURNAL_FILE = "journal.json";
const COMPLETED_FILE = "completed.json";

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function readDirectoryOrEmpty(path: string): Promise<ReadonlyArray<string>> {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await syncDirectory(NodePath.dirname(path));
}

function queryCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { readonly count: number } | undefined;
  return row?.count ?? 0;
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { readonly present: number } | undefined;
  return row?.present === 1;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  if (!hasTable(database, table)) return false;
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>
  ).some((entry) => entry.name === column);
}

function validateMigrationLedger(
  database: DatabaseSync,
  manifest: ReadonlyArray<readonly [number, string]>,
): boolean {
  if (!hasTable(database, "effect_sql_migrations")) return false;
  const rows = database
    .prepare("SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all() as Array<{ readonly id: number; readonly name: string }>;
  if (rows.length === 0) return false;

  let expectedIndex = 0;
  for (const row of rows) {
    const expected = manifest[expectedIndex];
    if (expected && row.id === expected[0] && row.name === expected[1]) {
      expectedIndex += 1;
      continue;
    }
    // Hotlap 0.0.44-0.0.45 used the upstream ledger before this feature.
    if (
      expectedIndex === manifest.length &&
      row.id === 52 &&
      row.name === "ProjectionThreadForks" &&
      hasColumn(database, "projection_threads", "forked_from_thread_id") &&
      hasColumn(database, "projection_threads", "forked_from_message_id")
    ) {
      continue;
    }
    return false;
  }

  if (hasTable(database, "hotlap_sql_migrations")) {
    const hotlapRows = database
      .prepare("SELECT migration_id AS id, name FROM hotlap_sql_migrations ORDER BY migration_id")
      .all() as Array<{ readonly id: number; readonly name: string }>;
    if (
      hotlapRows.some(
        (row, index) =>
          row.id !== index + 1 || row.id !== 1 || row.name !== "ProjectionThreadForks",
      )
    ) {
      return false;
    }
  }
  return true;
}

function databaseSummary(
  databasePath: string,
  migrationManifest: ReadonlyArray<readonly [number, string]>,
):
  | T3DesktopMigrationSummary
  | { readonly blocked: true; readonly reason: T3DesktopMigrationBlockedReason } {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return { blocked: true, reason: "schema-unsupported" };
  }
  try {
    if (!validateMigrationLedger(database, migrationManifest)) {
      return { blocked: true, reason: "schema-unsupported" };
    }
    for (const table of [
      "projection_projects",
      "projection_threads",
      "projection_thread_sessions",
      "projection_thread_messages",
      "projection_turns",
      "projection_pending_approvals",
      "provider_session_runtime",
    ]) {
      if (!hasTable(database, table)) return { blocked: true, reason: "schema-unsupported" };
    }

    const activeSessions = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE status IN ('starting', 'running')",
    );
    const streamingMessages = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM projection_thread_messages WHERE is_streaming != 0",
    );
    const activeTurns = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM projection_turns WHERE state IN ('pending', 'running')",
    );
    const activeProviderRuntime = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM provider_session_runtime WHERE status IN ('starting', 'running')",
    );
    const unresolvedApprovals = queryCount(
      database,
      "SELECT COUNT(*) AS count FROM projection_pending_approvals WHERE status = 'pending'",
    );
    const pendingInteractions =
      hasColumn(database, "projection_threads", "pending_approval_count") &&
      hasColumn(database, "projection_threads", "pending_user_input_count")
        ? queryCount(
            database,
            "SELECT COUNT(*) AS count FROM projection_threads WHERE pending_approval_count > 0 OR pending_user_input_count > 0",
          )
        : 0;
    if (
      activeSessions +
        streamingMessages +
        activeTurns +
        activeProviderRuntime +
        unresolvedApprovals +
        pendingInteractions >
      0
    ) {
      return { blocked: true, reason: "source-busy" };
    }

    return {
      projectCount: queryCount(
        database,
        "SELECT COUNT(*) AS count FROM projection_projects WHERE deleted_at IS NULL",
      ),
      threadCount: queryCount(
        database,
        "SELECT COUNT(*) AS count FROM projection_threads WHERE deleted_at IS NULL",
      ),
      destinationHasData: false,
      pairingTransfer: "re-pair-required",
    };
  } catch {
    return { blocked: true, reason: "schema-unsupported" };
  } finally {
    database.close();
  }
}

interface RuntimeState {
  readonly version: 1;
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
}

function parseRuntimeState(value: unknown): RuntimeState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    Number.isInteger(record.pid) &&
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    typeof record.origin === "string" &&
    typeof record.startedAt === "string"
    ? (record as unknown as RuntimeState)
    : null;
}

async function sourceRuntimeBlockReason(
  paths: T3DesktopMigrationPaths,
  probe: T3DesktopProcessProbe,
): Promise<T3DesktopMigrationBlockedReason | null> {
  if (await probe.isT3DesktopRunning()) return "source-running";
  const runtimePath = NodePath.join(paths.sourceStateDir, "server-runtime.json");
  if (!(await pathExists(runtimePath))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runtimePath, "utf8"));
  } catch {
    return "recovery-required";
  }
  const runtime = parseRuntimeState(parsed);
  if (runtime === null) return "recovery-required";
  return probe.isPidAlive(runtime.pid) ? "source-running" : null;
}

async function readCompleted(
  paths: T3DesktopMigrationPaths,
): Promise<T3DesktopMigrationInspection | null> {
  const receiptPath = NodePath.join(paths.migrationDir, COMPLETED_FILE);
  if (!(await pathExists(receiptPath))) return null;
  try {
    const value = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    if (
      value.version === 1 &&
      (value.pairingTransfer === "preserved" || value.pairingTransfer === "re-pair-required")
    ) {
      return { status: "completed", pairingTransfer: value.pairingTransfer };
    }
  } catch {
    // A corrupt completion marker is recovery state, never permission to rerun.
  }
  return { status: "blocked", reason: "recovery-required" };
}

export async function inspectT3DesktopMigration(
  input: InspectInput,
): Promise<T3DesktopMigrationInspection> {
  if (input.platform !== "darwin") return { status: "unavailable", reason: "unsupported-platform" };
  if (!input.isPackaged) return { status: "unavailable", reason: "development-build" };
  if (!input.usesDefaultDestinationHome) return { status: "unavailable", reason: "custom-home" };

  const completed = await readCompleted(input.paths);
  if (completed) return completed;
  if (await pathExists(NodePath.join(input.paths.migrationDir, JOURNAL_FILE))) {
    return { status: "blocked", reason: "recovery-required" };
  }
  if (!(await pathExists(NodePath.join(input.paths.sourceStateDir, "state.sqlite")))) {
    return { status: "unavailable", reason: "source-missing" };
  }
  const runtimeBlock = await sourceRuntimeBlockReason(input.paths, input.processProbe);
  if (runtimeBlock) return { status: "blocked", reason: runtimeBlock };

  const summary = databaseSummary(
    NodePath.join(input.paths.sourceStateDir, "state.sqlite"),
    input.migrationManifest,
  );
  if ("blocked" in summary) return { status: "blocked", reason: summary.reason };

  const destinationEntries = await readDirectoryOrEmpty(input.paths.destinationStateDir);
  const secretNames = await readDirectoryOrEmpty(
    NodePath.join(input.paths.sourceStateDir, "secrets"),
  );
  return {
    status: "ready",
    ...summary,
    destinationHasData: destinationEntries.length > 0,
    pairingTransfer: secretNames.includes("server-signing-key.bin")
      ? "preserved"
      : "re-pair-required",
  };
}

function isKnownAntigravitySkillLink(relativePath: string): boolean {
  const normalized = relativePath.split(NodePath.sep).join("/");
  return (
    normalized.startsWith("providers/antigravity/") &&
    (normalized.endsWith("/config/skills") || normalized.endsWith("/antigravity-cli/skills"))
  );
}

async function copyDurableEntry(
  source: string,
  destination: string,
  relativePath: string,
): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    if (isKnownAntigravitySkillLink(relativePath)) return;
    throw new Error(`Unsupported symbolic link in T3 Code data: ${relativePath}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
    for (const entry of await readdir(source)) {
      await copyDurableEntry(
        NodePath.join(source, entry),
        NodePath.join(destination, entry),
        NodePath.join(relativePath, entry),
      );
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported T3 Code data entry: ${relativePath}`);
  await mkdir(NodePath.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function prepareStage(input: {
  readonly sourceStateDir: string;
  readonly stageDir: string;
}): Promise<{ readonly unknownEntries: ReadonlyArray<string> }> {
  const entries = await readdir(input.sourceStateDir);
  const unknownEntries = entries.filter(
    (entry) =>
      entry !== "state.sqlite" &&
      entry !== "secrets" &&
      !COPIED_FILES.has(entry) &&
      !COPIED_DIRECTORIES.has(entry) &&
      !EXCLUDED_ENTRIES.has(entry),
  );
  if (unknownEntries.length > 0) return { unknownEntries };

  await mkdir(input.stageDir, { recursive: true, mode: 0o700 });
  await Effect.runPromise(
    snapshotSqliteDatabase({
      sourcePath: NodePath.join(input.sourceStateDir, "state.sqlite"),
      destinationPath: NodePath.join(input.stageDir, "state.sqlite"),
    }),
  );
  for (const entry of entries) {
    if (COPIED_FILES.has(entry) || COPIED_DIRECTORIES.has(entry)) {
      await copyDurableEntry(
        NodePath.join(input.sourceStateDir, entry),
        NodePath.join(input.stageDir, entry),
        entry,
      );
    }
  }

  const sourceSecrets = NodePath.join(input.sourceStateDir, "secrets");
  if (await pathExists(sourceSecrets)) {
    const destinationSecrets = NodePath.join(input.stageDir, "secrets");
    await mkdir(destinationSecrets, { recursive: true, mode: 0o700 });
    for (const name of await readdir(sourceSecrets)) {
      if (!ALLOWED_SECRET_NAMES.some((pattern) => pattern.test(name))) continue;
      await copyDurableEntry(
        NodePath.join(sourceSecrets, name),
        NodePath.join(destinationSecrets, name),
        NodePath.join("secrets", name),
      );
    }
  }
  return { unknownEntries: [] };
}

function makeJournalPaths(paths: T3DesktopMigrationPaths, runId: string) {
  return {
    sourceBackup: NodePath.join(paths.sourceBaseDir, "hotlap-backups", runId, "userdata"),
    destinationBackup: NodePath.join(paths.migrationDir, "backups", runId, "userdata"),
    stageDir: NodePath.join(paths.migrationDir, "staging", runId, "userdata"),
  };
}

async function writeJournal(
  paths: T3DesktopMigrationPaths,
  journal: MigrationJournal,
  phase: JournalPhase,
): Promise<MigrationJournal> {
  const next = { ...journal, phase };
  await writeJsonAtomically(NodePath.join(paths.migrationDir, JOURNAL_FILE), next);
  return next;
}

function journalMatchesPaths(paths: T3DesktopMigrationPaths, journal: MigrationJournal): boolean {
  if (!/^[A-Za-z0-9._-]+$/u.test(journal.runId)) return false;
  const expected = makeJournalPaths(paths, journal.runId);
  return (
    expected.sourceBackup === journal.sourceBackup &&
    expected.destinationBackup === journal.destinationBackup &&
    expected.stageDir === journal.stageDir
  );
}

async function readJournal(paths: T3DesktopMigrationPaths): Promise<MigrationJournal | null> {
  const journalPath = NodePath.join(paths.migrationDir, JOURNAL_FILE);
  if (!(await pathExists(journalPath))) return null;
  try {
    const value = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
    if (
      value.version !== 1 ||
      ![
        "prepared",
        "source-quarantined",
        "destination-stopped",
        "destination-backed-up",
        "destination-activated",
      ].includes(value.phase) ||
      !journalMatchesPaths(paths, value)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function moveAside(path: string, targetRoot: string, name: string): Promise<void> {
  if (!(await pathExists(path))) return;
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await rename(path, NodePath.join(targetRoot, name));
  await syncDirectory(NodePath.dirname(path));
}

export async function recoverT3DesktopMigration(
  paths: T3DesktopMigrationPaths,
): Promise<{
  readonly status: "none" | "recovered" | "blocked";
  readonly reason?: "recovery-required";
}> {
  const journalPath = NodePath.join(paths.migrationDir, JOURNAL_FILE);
  if (!(await pathExists(journalPath))) return { status: "none" };
  const journal = await readJournal(paths);
  if (journal === null) return { status: "blocked", reason: "recovery-required" };

  const sourceExists = await pathExists(paths.sourceStateDir);
  const sourceBackupExists = await pathExists(journal.sourceBackup);
  if (sourceExists && sourceBackupExists) {
    return { status: "blocked", reason: "recovery-required" };
  }
  if (!sourceExists && sourceBackupExists) {
    await mkdir(NodePath.dirname(paths.sourceStateDir), { recursive: true });
    await rename(journal.sourceBackup, paths.sourceStateDir);
    await syncDirectory(NodePath.dirname(paths.sourceStateDir));
  }

  const destinationBackupExists = await pathExists(journal.destinationBackup);
  if (destinationBackupExists) {
    if (await pathExists(paths.destinationStateDir)) {
      await moveAside(
        paths.destinationStateDir,
        NodePath.join(paths.migrationDir, "failed", journal.runId),
        "imported-userdata",
      );
    }
    await mkdir(NodePath.dirname(paths.destinationStateDir), { recursive: true });
    await rename(journal.destinationBackup, paths.destinationStateDir);
    await syncDirectory(NodePath.dirname(paths.destinationStateDir));
  } else if (
    journal.phase === "destination-activated" &&
    (await pathExists(paths.destinationStateDir))
  ) {
    await moveAside(
      paths.destinationStateDir,
      NodePath.join(paths.migrationDir, "failed", journal.runId),
      "imported-userdata",
    );
  }

  await unlink(journalPath);
  await syncDirectory(paths.migrationDir);
  return { status: "recovered" };
}

export async function migrateT3DesktopData(input: MigrateInput): Promise<T3DesktopMigrationResult> {
  const inspection = await inspectT3DesktopMigration({
    paths: input.paths,
    platform: "darwin",
    isPackaged: true,
    usesDefaultDestinationHome: true,
    processProbe: input.processProbe,
    migrationManifest: input.migrationManifest,
  });
  if (inspection.status !== "ready") {
    return inspection.status === "completed"
      ? inspection
      : { status: "blocked", reason: inspection.reason };
  }
  if (inspection.destinationHasData && !input.replaceExisting) {
    return { status: "blocked", reason: "destination-changed" };
  }

  const runId =
    input.makeRunId?.() ??
    `${(input.now?.() ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const runPaths = makeJournalPaths(input.paths, runId);
  const journalBase: MigrationJournal = { version: 1, runId, phase: "prepared", ...runPaths };
  let journal = journalBase;
  let destinationStopped = false;
  let activated = false;
  let blockedReason: T3DesktopMigrationBlockedReason | null = null;

  try {
    const finalBlock = await sourceRuntimeBlockReason(input.paths, input.processProbe);
    const finalSummary = databaseSummary(
      NodePath.join(input.paths.sourceStateDir, "state.sqlite"),
      input.migrationManifest,
    );
    if (
      finalBlock ||
      "blocked" in finalSummary ||
      finalSummary.projectCount !== inspection.projectCount ||
      finalSummary.threadCount !== inspection.threadCount
    ) {
      return { status: "blocked", reason: finalBlock ?? "source-busy" };
    }

    await mkdir(NodePath.dirname(runPaths.sourceBackup), { recursive: true, mode: 0o700 });
    await mkdir(NodePath.dirname(runPaths.destinationBackup), { recursive: true, mode: 0o700 });
    journal = await writeJournal(input.paths, journal, "prepared");
    await rename(input.paths.sourceStateDir, runPaths.sourceBackup);
    await syncDirectory(NodePath.dirname(input.paths.sourceStateDir));
    journal = await writeJournal(input.paths, journal, "source-quarantined");
    if (
      (await pathExists(input.paths.sourceStateDir)) ||
      (await input.processProbe.isT3DesktopRunning())
    ) {
      return { status: "blocked", reason: "recovery-required" };
    }

    // Snapshot only after the source has been quarantined. An already-open T3
    // process can no longer race the copy through its former path.
    const prepared = await prepareStage({
      sourceStateDir: runPaths.sourceBackup,
      stageDir: runPaths.stageDir,
    });
    if (prepared.unknownEntries.length > 0) {
      blockedReason = "unknown-source-entry";
      throw new Error("The T3 Code workspace contains an unknown durable entry.");
    }
    const stagedSummary = databaseSummary(
      NodePath.join(runPaths.stageDir, "state.sqlite"),
      input.migrationManifest,
    );
    if ("blocked" in stagedSummary)
      throw new Error("The staged T3 Code database failed validation.");
    const stagedEnvironmentId = await readFile(
      NodePath.join(runPaths.stageDir, "environment-id"),
      "utf8",
    );
    const sourceEnvironmentId = await readFile(
      NodePath.join(runPaths.sourceBackup, "environment-id"),
      "utf8",
    );
    if (
      stagedSummary.projectCount !== inspection.projectCount ||
      stagedSummary.threadCount !== inspection.threadCount ||
      stagedEnvironmentId !== sourceEnvironmentId
    ) {
      throw new Error("The staged T3 Code data did not match its source.");
    }

    await input.hooks.stopDestinationBackend();
    destinationStopped = true;
    journal = await writeJournal(input.paths, journal, "destination-stopped");

    if (await pathExists(input.paths.destinationStateDir)) {
      await rename(input.paths.destinationStateDir, runPaths.destinationBackup);
      await syncDirectory(NodePath.dirname(input.paths.destinationStateDir));
    }
    journal = await writeJournal(input.paths, journal, "destination-backed-up");
    await mkdir(NodePath.dirname(input.paths.destinationStateDir), { recursive: true });
    await rename(runPaths.stageDir, input.paths.destinationStateDir);
    await syncDirectory(NodePath.dirname(input.paths.destinationStateDir));
    activated = true;
    journal = await writeJournal(input.paths, journal, "destination-activated");

    await input.hooks.reloadDestinationSettings();
    await input.hooks.startAndValidateDestinationBackend();
    await writeJsonAtomically(NodePath.join(input.paths.migrationDir, COMPLETED_FILE), {
      version: 1,
      completedAt: (input.now?.() ?? new Date()).toISOString(),
      pairingTransfer: inspection.pairingTransfer,
      sourceStateDir: input.paths.sourceStateDir,
      sourceBackup: runPaths.sourceBackup,
      destinationBackup: (await pathExists(runPaths.destinationBackup))
        ? runPaths.destinationBackup
        : null,
    });
    await unlink(NodePath.join(input.paths.migrationDir, JOURNAL_FILE));
    await syncDirectory(input.paths.migrationDir);
    return { status: "completed", pairingTransfer: inspection.pairingTransfer };
  } catch (error) {
    try {
      if (activated) {
        await input.hooks.stopDestinationBackend();
        await moveAside(
          input.paths.destinationStateDir,
          NodePath.join(input.paths.migrationDir, "failed", runId),
          "imported-userdata",
        );
      }
      if (await pathExists(runPaths.destinationBackup)) {
        if (await pathExists(input.paths.destinationStateDir)) {
          return { status: "failed", message: "Migration recovery needs manual attention." };
        }
        await rename(runPaths.destinationBackup, input.paths.destinationStateDir);
      }
      if (await pathExists(runPaths.sourceBackup)) {
        if (await pathExists(input.paths.sourceStateDir)) {
          return {
            status: "failed",
            message: "T3 Code reopened during migration; its backup was preserved.",
          };
        }
        await rename(runPaths.sourceBackup, input.paths.sourceStateDir);
      }
      if (destinationStopped) await input.hooks.restartPreviousDestinationBackend();
      await rm(NodePath.dirname(runPaths.stageDir), { recursive: true, force: true });
      if (await pathExists(NodePath.join(input.paths.migrationDir, JOURNAL_FILE))) {
        await unlink(NodePath.join(input.paths.migrationDir, JOURNAL_FILE));
      }
    } catch {
      return {
        status: "failed",
        message: "Migration failed and requires recovery on next launch.",
      };
    }
    if (blockedReason !== null) return { status: "blocked", reason: blockedReason };
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "T3 Code migration failed.",
    };
  }
}
