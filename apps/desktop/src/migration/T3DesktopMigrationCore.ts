// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- This desktop migration boundary needs atomic filesystem moves, SQLite inspection, and durable wall-clock receipts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

const { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } = NodeFSP;
const { randomUUID } = NodeCrypto;

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
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly usesDefaultDestinationHome: boolean;
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
  "clerk-tokens.json",
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

async function destinationHasWorkspaceData(paths: T3DesktopMigrationPaths): Promise<boolean> {
  const entries = await readDirectoryOrEmpty(paths.destinationStateDir);
  if (entries.length === 0) return false;

  for (const configFile of [
    "clerk-tokens.json",
    "client-settings.json",
    "connection-catalog.json",
    "keybindings.json",
    "saved-environments.json",
    "settings.json",
  ]) {
    if (entries.includes(configFile)) return true;
  }

  if (entries.includes("desktop-settings.json")) {
    try {
      const settings = JSON.parse(
        await readFile(NodePath.join(paths.destinationStateDir, "desktop-settings.json"), "utf8"),
      ) as unknown;
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return true;
      const baselineKeys = new Set(["mainWindowBounds", "mainWindowMaximized"]);
      if (Object.keys(settings).some((key) => !baselineKeys.has(key))) return true;
    } catch {
      return true;
    }
  }

  const databasePath = NodePath.join(paths.destinationStateDir, "state.sqlite");
  if (await pathExists(databasePath)) {
    let database: NodeSqlite.DatabaseSync;
    try {
      database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    } catch {
      return true;
    }
    try {
      if (!hasTable(database, "projection_projects") || !hasTable(database, "projection_threads")) {
        return true;
      }
      if (
        queryCount(database, "SELECT COUNT(*) AS count FROM projection_projects") > 0 ||
        queryCount(database, "SELECT COUNT(*) AS count FROM projection_threads") > 0
      ) {
        return true;
      }
      if (
        hasTable(database, "auth_sessions") &&
        queryCount(
          database,
          "SELECT COUNT(*) AS count FROM auth_sessions WHERE subject != 'desktop-bootstrap' OR method != 'bearer-access-token'",
        ) > 0
      ) {
        return true;
      }
      if (
        hasTable(database, "auth_pairing_links") &&
        queryCount(database, "SELECT COUNT(*) AS count FROM auth_pairing_links") > 0
      ) {
        return true;
      }
    } catch {
      return true;
    } finally {
      database.close();
    }
  }

  for (const directory of [
    "attachments",
    "browser-artifacts",
    "device",
    "providers",
    "snap-shots",
    "themes",
  ]) {
    if (
      (await readDirectoryOrEmpty(NodePath.join(paths.destinationStateDir, directory))).length > 0
    ) {
      return true;
    }
  }

  const secrets = await readDirectoryOrEmpty(NodePath.join(paths.destinationStateDir, "secrets"));
  const baselineSecrets = new Set([
    "asset-access-signing-key.bin",
    "cloud-link-ed25519-key-pair.bin",
    "server-signing-key.bin",
  ]);
  if (secrets.some((secret) => !baselineSecrets.has(secret))) return true;

  const baselineEntries = new Set([
    ...COPIED_DIRECTORIES,
    ...EXCLUDED_ENTRIES,
    "desktop-settings.json",
    "environment-id",
    "secrets",
    "state.sqlite",
  ]);
  return entries.some((entry) => !baselineEntries.has(entry));
}

async function hasPlainSourceLayout(paths: T3DesktopMigrationPaths): Promise<boolean> {
  try {
    const [stateDirectory, database] = await Promise.all([
      lstat(paths.sourceStateDir),
      lstat(NodePath.join(paths.sourceStateDir, "state.sqlite")),
    ]);
    return (
      stateDirectory.isDirectory() &&
      !stateDirectory.isSymbolicLink() &&
      database.isFile() &&
      !database.isSymbolicLink()
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

function queryCount(database: NodeSqlite.DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { readonly count: number } | undefined;
  return row?.count ?? 0;
}

function hasTable(database: NodeSqlite.DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { readonly present: number } | undefined;
  return row?.present === 1;
}

function hasColumn(database: NodeSqlite.DatabaseSync, table: string, column: string): boolean {
  if (!hasTable(database, table)) return false;
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>
  ).some((entry) => entry.name === column);
}

function validateMigrationLedger(
  database: NodeSqlite.DatabaseSync,
  manifest: ReadonlyArray<readonly [number, string]>,
): boolean {
  if (!hasTable(database, "effect_sql_migrations")) return false;
  const rows = database
    .prepare("SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all() as Array<{ readonly id: number; readonly name: string }>;
  if (rows.length === 0 || manifest.length === 0) return false;

  let expectedIndex = 0;
  let acceptedLegacyHotlapMigration = false;
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
      hasColumn(database, "projection_threads", "fork_source_thread_id") &&
      hasColumn(database, "projection_threads", "fork_source_message_id")
    ) {
      acceptedLegacyHotlapMigration = true;
      continue;
    }
    return false;
  }
  if (hasTable(database, "hotlap_sql_migrations")) {
    const hotlapRows = database
      .prepare("SELECT migration_id AS id, name FROM hotlap_sql_migrations ORDER BY migration_id")
      .all() as Array<{ readonly id: number; readonly name: string }>;
    if (
      acceptedLegacyHotlapMigration ||
      hotlapRows.length !== 1 ||
      hotlapRows[0]?.id !== 1 ||
      hotlapRows[0].name !== "ProjectionThreadForks"
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
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
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

interface CompletedMigrationReceipt {
  readonly version: 1;
  readonly completedAt: string;
  readonly pairingTransfer: T3DesktopMigrationSummary["pairingTransfer"];
  readonly sourceStateDir: string;
  readonly sourceBackup: string;
  readonly destinationBackup: string | null;
}

async function readCompletedReceipt(
  paths: T3DesktopMigrationPaths,
): Promise<CompletedMigrationReceipt | "invalid" | null> {
  const receiptPath = NodePath.join(paths.migrationDir, COMPLETED_FILE);
  if (!(await pathExists(receiptPath))) return null;
  try {
    const value = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    if (
      value.version === 1 &&
      typeof value.completedAt === "string" &&
      (value.pairingTransfer === "preserved" || value.pairingTransfer === "re-pair-required") &&
      typeof value.sourceStateDir === "string" &&
      typeof value.sourceBackup === "string" &&
      (typeof value.destinationBackup === "string" || value.destinationBackup === null)
    ) {
      return value as unknown as CompletedMigrationReceipt;
    }
  } catch {
    // A corrupt completion marker is recovery state, never permission to rerun.
  }
  return "invalid";
}

async function readCompleted(
  paths: T3DesktopMigrationPaths,
): Promise<T3DesktopMigrationInspection | null> {
  const receipt = await readCompletedReceipt(paths);
  if (receipt === null) return null;
  if (receipt === "invalid") return { status: "blocked", reason: "recovery-required" };
  return { status: "completed", pairingTransfer: receipt.pairingTransfer };
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
  if (!(await hasPlainSourceLayout(input.paths))) {
    return { status: "blocked", reason: "unknown-source-entry" };
  }
  const runtimeBlock = await sourceRuntimeBlockReason(input.paths, input.processProbe);
  if (runtimeBlock) return { status: "blocked", reason: runtimeBlock };

  const summary = databaseSummary(
    NodePath.join(input.paths.sourceStateDir, "state.sqlite"),
    input.migrationManifest,
  );
  if ("blocked" in summary) return { status: "blocked", reason: summary.reason };

  const secretNames = await readDirectoryOrEmpty(
    NodePath.join(input.paths.sourceStateDir, "secrets"),
  );
  return {
    status: "ready",
    ...summary,
    destinationHasData: await destinationHasWorkspaceData(input.paths),
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

interface DestinationDatabaseObserver {
  readonly databasePath: string;
  readonly database: NodeSqlite.DatabaseSync | null;
  readonly dataVersion: number | null;
  readonly device: number | null;
  readonly inode: number | null;
}

function readDataVersion(database: NodeSqlite.DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as
    | { readonly data_version: number }
    | undefined;
  return row?.data_version ?? 0;
}

async function observeDestinationDatabase(
  paths: T3DesktopMigrationPaths,
): Promise<DestinationDatabaseObserver> {
  const databasePath = NodePath.join(paths.destinationStateDir, "state.sqlite");
  if (!(await pathExists(databasePath))) {
    return { databasePath, database: null, dataVersion: null, device: null, inode: null };
  }
  const identity = await stat(databasePath);
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  return {
    databasePath,
    database,
    dataVersion: readDataVersion(database),
    device: identity.dev,
    inode: identity.ino,
  };
}

async function destinationDatabaseChanged(observer: DestinationDatabaseObserver): Promise<boolean> {
  if (observer.database === null) return pathExists(observer.databasePath);
  if (!(await pathExists(observer.databasePath))) return true;
  const identity = await stat(observer.databasePath);
  return (
    identity.dev !== observer.device ||
    identity.ino !== observer.inode ||
    readDataVersion(observer.database) !== observer.dataVersion
  );
}

async function sourceReopenedAfterQuarantine(input: {
  readonly paths: T3DesktopMigrationPaths;
  readonly sourceBackup: string;
  readonly processProbe: T3DesktopProcessProbe;
}): Promise<boolean> {
  if (await pathExists(input.paths.sourceStateDir)) return true;
  return (
    (await sourceRuntimeBlockReason(
      { ...input.paths, sourceStateDir: input.sourceBackup },
      input.processProbe,
    )) !== null
  );
}

async function completionMatchesJournal(
  paths: T3DesktopMigrationPaths,
  journal: MigrationJournal,
): Promise<boolean> {
  const receipt = await readCompletedReceipt(paths);
  if (receipt === null || receipt === "invalid" || journal.phase !== "destination-activated") {
    return false;
  }
  const expectedDestinationBackup = (await pathExists(journal.destinationBackup))
    ? journal.destinationBackup
    : null;
  return (
    receipt.sourceStateDir === paths.sourceStateDir &&
    receipt.sourceBackup === journal.sourceBackup &&
    receipt.destinationBackup === expectedDestinationBackup &&
    (await pathExists(paths.destinationStateDir)) &&
    (await pathExists(journal.sourceBackup))
  );
}

export async function recoverT3DesktopMigration(paths: T3DesktopMigrationPaths): Promise<{
  readonly status: "none" | "recovered" | "blocked";
  readonly reason?: "recovery-required";
}> {
  const journalPath = NodePath.join(paths.migrationDir, JOURNAL_FILE);
  if (!(await pathExists(journalPath))) return { status: "none" };
  const journal = await readJournal(paths);
  if (journal === null) return { status: "blocked", reason: "recovery-required" };
  if (await completionMatchesJournal(paths, journal)) {
    await unlink(journalPath);
    await syncDirectory(paths.migrationDir);
    return { status: "recovered" };
  }

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
    platform: input.platform,
    isPackaged: input.isPackaged,
    usesDefaultDestinationHome: input.usesDefaultDestinationHome,
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
  const destinationObserver = await observeDestinationDatabase(input.paths);

  const runId =
    input.makeRunId?.() ??
    `${(input.now?.() ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const runPaths = makeJournalPaths(input.paths, runId);
  const journalBase: MigrationJournal = { version: 1, runId, phase: "prepared", ...runPaths };
  let journal = journalBase;
  let destinationStopped = false;
  let activated = false;
  let committed = false;
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
      await sourceReopenedAfterQuarantine({
        paths: input.paths,
        sourceBackup: runPaths.sourceBackup,
        processProbe: input.processProbe,
      })
    ) {
      blockedReason = "recovery-required";
      throw new Error("T3 Code reopened during migration.");
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
    if (
      await sourceReopenedAfterQuarantine({
        paths: input.paths,
        sourceBackup: runPaths.sourceBackup,
        processProbe: input.processProbe,
      })
    ) {
      blockedReason = "recovery-required";
      throw new Error("T3 Code reopened during migration.");
    }

    destinationStopped = true;
    await input.hooks.stopDestinationBackend();
    if (await destinationDatabaseChanged(destinationObserver)) {
      blockedReason = "destination-changed";
      throw new Error("Hotlap changed while the migration was being prepared.");
    }
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
    if (
      await sourceReopenedAfterQuarantine({
        paths: input.paths,
        sourceBackup: runPaths.sourceBackup,
        processProbe: input.processProbe,
      })
    ) {
      blockedReason = "recovery-required";
      throw new Error("T3 Code reopened during migration.");
    }
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
    committed = true;
    await unlink(NodePath.join(input.paths.migrationDir, JOURNAL_FILE));
    await syncDirectory(input.paths.migrationDir);
    return { status: "completed", pairingTransfer: inspection.pairingTransfer };
  } catch (error) {
    if (committed || (await completionMatchesJournal(input.paths, journal))) {
      return { status: "completed", pairingTransfer: inspection.pairingTransfer };
    }
    let recoveryMessage: string | null = null;
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
          recoveryMessage = "Migration recovery needs manual attention.";
        } else {
          await rename(runPaths.destinationBackup, input.paths.destinationStateDir);
        }
      }
      if (await pathExists(runPaths.sourceBackup)) {
        if (await pathExists(input.paths.sourceStateDir)) {
          recoveryMessage = "T3 Code reopened during migration; its backup was preserved.";
        } else {
          await rename(runPaths.sourceBackup, input.paths.sourceStateDir);
        }
      }
      if (activated) await input.hooks.reloadDestinationSettings();
      if (destinationStopped) await input.hooks.restartPreviousDestinationBackend();
      if (recoveryMessage === null) {
        await rm(NodePath.dirname(runPaths.stageDir), { recursive: true, force: true });
        if (await pathExists(NodePath.join(input.paths.migrationDir, JOURNAL_FILE))) {
          await unlink(NodePath.join(input.paths.migrationDir, JOURNAL_FILE));
        }
      }
    } catch {
      return {
        status: "failed",
        message: "Migration failed and requires recovery on next launch.",
      };
    }
    if (recoveryMessage !== null) return { status: "failed", message: recoveryMessage };
    if (blockedReason !== null) return { status: "blocked", reason: blockedReason };
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "T3 Code migration failed.",
    };
  } finally {
    destinationObserver.database?.close();
  }
}
