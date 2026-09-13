// @effect-diagnostics nodeBuiltinImport:off -- Isolated temporary homes exercise the real atomic migration filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } = NodeFSP;
const { DatabaseSync } = NodeSqlite;

import { assert, describe, it } from "@effect/vitest";
import { t3MigrationManifest } from "@t3tools/shared/t3MigrationManifest";

import {
  inspectT3DesktopMigration,
  migrateT3DesktopData,
  recoverT3DesktopMigration,
  type T3DesktopMigrationPaths,
} from "./T3DesktopMigrationCore.ts";

async function makeFixture(): Promise<T3DesktopMigrationPaths> {
  const root = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "hotlap-t3-switch-"));
  const sourceBaseDir = NodePath.join(root, ".t3");
  const destinationBaseDir = NodePath.join(root, ".hotlap");
  const sourceStateDir = NodePath.join(sourceBaseDir, "userdata");
  const destinationStateDir = NodePath.join(destinationBaseDir, "userdata");
  const migrationDir = NodePath.join(destinationBaseDir, "migrations", "t3-desktop");
  await mkdir(sourceStateDir, { recursive: true });

  const database = new DatabaseSync(NodePath.join(sourceStateDir, "state.sqlite"));
  database.exec(`
    CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      deleted_at TEXT,
      pending_approval_count INTEGER NOT NULL DEFAULT 0,
      pending_user_input_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, is_streaming INTEGER NOT NULL);
    CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO projection_projects VALUES ('project-1', NULL), ('project-2', NULL);
    INSERT INTO projection_threads VALUES ('thread-1', NULL, 0, 0), ('thread-2', NULL, 0, 0), ('thread-3', 'now', 0, 0);
  `);
  const insertMigration = database.prepare(
    "INSERT INTO effect_sql_migrations VALUES (?, ?, 'now')",
  );
  for (const [id, name] of t3MigrationManifest) insertMigration.run(id, name);
  database.close();
  await writeFile(NodePath.join(sourceStateDir, "environment-id"), "source-environment\n");
  await writeFile(NodePath.join(sourceStateDir, "settings.json"), '{"customPrompts":[]}\n');
  await mkdir(NodePath.join(sourceStateDir, "secrets"));
  await writeFile(
    NodePath.join(sourceStateDir, "secrets", "server-signing-key.bin"),
    "signing-key",
  );

  return {
    sourceBaseDir,
    sourceStateDir,
    destinationBaseDir,
    destinationStateDir,
    migrationDir,
  };
}

const closedProcessProbe = {
  isPidAlive: () => false,
  isT3DesktopRunning: async () => false,
};

const supportedMigration = {
  platform: "darwin",
  isPackaged: true,
  usesDefaultDestinationHome: true,
} as const;

describe("T3DesktopMigrationCore", () => {
  it("finds a closed, idle T3 desktop workspace and reports durable counts", async () => {
    const paths = await makeFixture();
    const inspection = await inspectT3DesktopMigration({
      paths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });

    assert.deepStrictEqual(inspection, {
      status: "ready",
      projectCount: 2,
      threadCount: 2,
      destinationHasData: false,
      pairingTransfer: "preserved",
    });
  });

  it("does not treat a backend-initialized empty Hotlap home as existing work", async () => {
    const paths = await makeFixture();
    await mkdir(paths.destinationStateDir, { recursive: true });
    const destinationDatabase = new DatabaseSync(
      NodePath.join(paths.destinationStateDir, "state.sqlite"),
    );
    destinationDatabase.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE auth_sessions (subject TEXT NOT NULL, method TEXT NOT NULL);
      CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY);
      INSERT INTO auth_sessions VALUES ('desktop-bootstrap', 'bearer-access-token');
    `);
    await writeFile(NodePath.join(paths.destinationStateDir, "environment-id"), "hotlap\n");
    await writeFile(
      NodePath.join(paths.destinationStateDir, "desktop-settings.json"),
      '{"mainWindowBounds":{"x":0,"y":0,"width":1200,"height":800}}\n',
    );
    await mkdir(NodePath.join(paths.destinationStateDir, "attachments"));
    await mkdir(NodePath.join(paths.destinationStateDir, "logs"));
    await mkdir(NodePath.join(paths.destinationStateDir, "secrets"));
    await writeFile(
      NodePath.join(paths.destinationStateDir, "secrets", "server-signing-key.bin"),
      "generated-signing-key",
    );

    const emptyInspection = await inspectT3DesktopMigration({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(emptyInspection.status, "ready");
    assert.isFalse(emptyInspection.status === "ready" && emptyInspection.destinationHasData);

    destinationDatabase.exec("INSERT INTO projection_projects VALUES ('hotlap-project', NULL)");
    destinationDatabase.close();

    const populatedInspection = await inspectT3DesktopMigration({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(populatedInspection.status, "ready");
    assert.isTrue(populatedInspection.status === "ready" && populatedInspection.destinationHasData);
  });

  it("protects configuration-only Hotlap homes from replacement without consent", async () => {
    const settingsPaths = await makeFixture();
    await mkdir(settingsPaths.destinationStateDir, { recursive: true });
    await writeFile(
      NodePath.join(settingsPaths.destinationStateDir, "settings.json"),
      '{"customPrompts":[{"name":"Ship","prompt":"Ship safely"}]}\n',
    );
    const settingsInspection = await inspectT3DesktopMigration({
      paths: settingsPaths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(settingsInspection.status, "ready");
    assert.isTrue(settingsInspection.status === "ready" && settingsInspection.destinationHasData);

    const secretPaths = await makeFixture();
    await mkdir(NodePath.join(secretPaths.destinationStateDir, "secrets"), { recursive: true });
    await writeFile(
      NodePath.join(secretPaths.destinationStateDir, "secrets", "provider-env-codex-main.bin"),
      "encrypted-provider-token",
    );
    const secretInspection = await inspectT3DesktopMigration({
      paths: secretPaths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(secretInspection.status, "ready");
    assert.isTrue(secretInspection.status === "ready" && secretInspection.destinationHasData);

    const pairedPaths = await makeFixture();
    await mkdir(pairedPaths.destinationStateDir, { recursive: true });
    const pairedDatabase = new DatabaseSync(
      NodePath.join(pairedPaths.destinationStateDir, "state.sqlite"),
    );
    pairedDatabase.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT);
      CREATE TABLE auth_sessions (subject TEXT NOT NULL, method TEXT NOT NULL);
      INSERT INTO auth_sessions VALUES ('one-time-token', 'bearer-access-token');
    `);
    pairedDatabase.close();
    const pairedInspection = await inspectT3DesktopMigration({
      paths: pairedPaths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(pairedInspection.status, "ready");
    assert.isTrue(pairedInspection.status === "ready" && pairedInspection.destinationHasData);
  });

  it("enforces eligibility when migration is called directly", async () => {
    const paths = await makeFixture();
    let stopped = false;
    const result = await migrateT3DesktopData({
      paths,
      platform: "linux",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: false,
      hooks: {
        stopDestinationBackend: async () => {
          stopped = true;
        },
        startAndValidateDestinationBackend: async () => undefined,
        reloadDestinationSettings: async () => undefined,
        restartPreviousDestinationBackend: async () => undefined,
      },
    });

    assert.deepStrictEqual(result, { status: "blocked", reason: "unsupported-platform" });
    assert.isFalse(stopped);
    assert.strictEqual(
      await readFile(NodePath.join(paths.sourceStateDir, "environment-id"), "utf8"),
      "source-environment\n",
    );
  });

  it("fails closed when the T3 state root is a symbolic link", async () => {
    const paths = await makeFixture();
    const relocatedState = NodePath.join(NodePath.dirname(paths.sourceBaseDir), "relocated-t3");
    await rename(paths.sourceStateDir, relocatedState);
    await symlink(relocatedState, paths.sourceStateDir, "dir");

    const inspection = await inspectT3DesktopMigration({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });

    assert.deepStrictEqual(inspection, {
      status: "blocked",
      reason: "unknown-source-entry",
    });
  });

  it("fails closed for a live runtime, malformed runtime state, or active work", async () => {
    const livePaths = await makeFixture();
    await writeFile(
      NodePath.join(livePaths.sourceStateDir, "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: 42,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "now",
      }),
    );
    const liveInspection = await inspectT3DesktopMigration({
      paths: livePaths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: { ...closedProcessProbe, isPidAlive: () => true },
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(liveInspection.status, "blocked");
    assert("reason" in liveInspection);
    assert.strictEqual(liveInspection.reason, "source-running");

    const malformedPaths = await makeFixture();
    await writeFile(
      NodePath.join(malformedPaths.sourceStateDir, "server-runtime.json"),
      "not-json",
    );
    const malformedInspection = await inspectT3DesktopMigration({
      paths: malformedPaths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(malformedInspection.status, "blocked");
    assert("reason" in malformedInspection);
    assert.strictEqual(malformedInspection.reason, "recovery-required");

    const busyPaths = await makeFixture();
    const busyDatabase = new DatabaseSync(NodePath.join(busyPaths.sourceStateDir, "state.sqlite"));
    busyDatabase.exec("INSERT INTO projection_thread_sessions VALUES ('thread-1', 'running')");
    busyDatabase.close();
    const busyInspection = await inspectT3DesktopMigration({
      paths: busyPaths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(busyInspection.status, "blocked");
    assert("reason" in busyInspection);
    assert.strictEqual(busyInspection.reason, "source-busy");
  });

  it("rejects incomplete or malformed migration ledgers", async () => {
    const incompletePaths = await makeFixture();
    const incompleteDatabase = new DatabaseSync(
      NodePath.join(incompletePaths.sourceStateDir, "state.sqlite"),
    );
    const lastMigrationId = t3MigrationManifest.at(-1)?.[0];
    assert.ok(lastMigrationId);
    incompleteDatabase
      .prepare("DELETE FROM effect_sql_migrations WHERE migration_id = ?")
      .run(lastMigrationId);
    incompleteDatabase.close();

    const incompleteInspection = await inspectT3DesktopMigration({
      paths: incompletePaths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(incompleteInspection.status, "blocked");
    assert("reason" in incompleteInspection);
    assert.strictEqual(incompleteInspection.reason, "schema-unsupported");

    const malformedHotlapPaths = await makeFixture();
    const malformedHotlapDatabase = new DatabaseSync(
      NodePath.join(malformedHotlapPaths.sourceStateDir, "state.sqlite"),
    );
    malformedHotlapDatabase.exec(`
      CREATE TABLE hotlap_sql_migrations (
        migration_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT
      );
    `);
    malformedHotlapDatabase.close();

    const malformedHotlapInspection = await inspectT3DesktopMigration({
      paths: malformedHotlapPaths,
      platform: "darwin",
      isPackaged: true,
      usesDefaultDestinationHome: true,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });
    assert.strictEqual(malformedHotlapInspection.status, "blocked");
    assert("reason" in malformedHotlapInspection);
    assert.strictEqual(malformedHotlapInspection.reason, "schema-unsupported");
  });

  it("accepts the exact legacy Hotlap fork migration", async () => {
    const paths = await makeFixture();
    const database = new DatabaseSync(NodePath.join(paths.sourceStateDir, "state.sqlite"));
    database.exec(`
      ALTER TABLE projection_threads ADD COLUMN fork_source_thread_id TEXT;
      ALTER TABLE projection_threads ADD COLUMN fork_source_message_id TEXT;
      INSERT INTO effect_sql_migrations VALUES (52, 'ProjectionThreadForks', 'now');
    `);
    database.close();

    const inspection = await inspectT3DesktopMigration({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
    });

    assert.strictEqual(inspection.status, "ready");
  });

  it("copies only durable state and rejects unknown source entries", async () => {
    const paths = await makeFixture();
    await mkdir(NodePath.join(paths.sourceStateDir, "attachments"));
    await writeFile(NodePath.join(paths.sourceStateDir, "attachments", "image.png"), "pixels");
    await writeFile(
      NodePath.join(paths.sourceStateDir, "secrets", "server-signing-key.bin"),
      "key",
    );
    await writeFile(
      NodePath.join(paths.sourceStateDir, "secrets", "cloud-cli-oauth-token.bin"),
      "omit",
    );
    await writeFile(NodePath.join(paths.sourceStateDir, "anonymous-id"), "omit");
    await writeFile(NodePath.join(paths.sourceStateDir, "clerk-tokens.json"), "omit");
    await mkdir(NodePath.join(paths.sourceStateDir, "logs"));
    await writeFile(NodePath.join(paths.sourceStateDir, "logs", "server.log"), "omit");

    const lifecycle: string[] = [];
    const result = await migrateT3DesktopData({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: false,
      hooks: {
        stopDestinationBackend: async () => {
          lifecycle.push("stop");
        },
        startAndValidateDestinationBackend: async () => {
          lifecycle.push("validate");
        },
        reloadDestinationSettings: async () => {
          lifecycle.push("reload-settings");
        },
        restartPreviousDestinationBackend: async () => {
          lifecycle.push("restart-old");
        },
      },
    });

    assert.strictEqual(result.status, "completed");
    assert.deepStrictEqual(lifecycle, ["stop", "reload-settings", "validate"]);
    assert.strictEqual(
      await readFile(NodePath.join(paths.destinationStateDir, "attachments", "image.png"), "utf8"),
      "pixels",
    );
    assert.deepStrictEqual(await readdir(NodePath.join(paths.destinationStateDir, "secrets")), [
      "server-signing-key.bin",
    ]);
    assert(!(await readdir(paths.destinationStateDir)).includes("anonymous-id"));
    assert(!(await readdir(paths.destinationStateDir)).includes("clerk-tokens.json"));
    assert(!(await readdir(paths.destinationStateDir)).includes("logs"));
    const completion = JSON.parse(
      await readFile(NodePath.join(paths.migrationDir, "completed.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.strictEqual(completion.sourceStateDir, paths.sourceStateDir);

    const unknownPaths = await makeFixture();
    await writeFile(NodePath.join(unknownPaths.sourceStateDir, "future-state.bin"), "unknown");
    const unknownResult = await migrateT3DesktopData({
      paths: unknownPaths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: false,
      hooks: {
        stopDestinationBackend: async () => undefined,
        startAndValidateDestinationBackend: async () => undefined,
        reloadDestinationSettings: async () => undefined,
        restartPreviousDestinationBackend: async () => undefined,
      },
    });
    assert.strictEqual(unknownResult.status, "blocked");
    assert("reason" in unknownResult);
    assert.strictEqual(unknownResult.reason, "unknown-source-entry");
  });

  it("restores both homes when imported backend validation fails", async () => {
    const paths = await makeFixture();
    await mkdir(paths.destinationStateDir, { recursive: true });
    await writeFile(NodePath.join(paths.destinationStateDir, "old.txt"), "old-hotlap");

    const lifecycle: string[] = [];
    const result = await migrateT3DesktopData({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: true,
      hooks: {
        stopDestinationBackend: async () => {
          lifecycle.push("stop");
        },
        startAndValidateDestinationBackend: async () => {
          lifecycle.push("validate");
          throw new Error("not ready");
        },
        reloadDestinationSettings: async () => {
          lifecycle.push("reload-settings");
        },
        restartPreviousDestinationBackend: async () => {
          lifecycle.push("restart-old");
        },
      },
    });

    assert.strictEqual(result.status, "failed");
    assert.deepStrictEqual(lifecycle, [
      "stop",
      "reload-settings",
      "validate",
      "stop",
      "reload-settings",
      "restart-old",
    ]);
    assert.strictEqual(
      await readFile(NodePath.join(paths.destinationStateDir, "old.txt"), "utf8"),
      "old-hotlap",
    );
    assert.strictEqual(
      await readFile(NodePath.join(paths.sourceStateDir, "environment-id"), "utf8"),
      "source-environment\n",
    );
  });

  it("aborts when Hotlap changes before activation", async () => {
    const paths = await makeFixture();
    await mkdir(paths.destinationStateDir, { recursive: true });
    const destinationDatabasePath = NodePath.join(paths.destinationStateDir, "state.sqlite");
    const destinationDatabase = new DatabaseSync(destinationDatabasePath);
    destinationDatabase.exec("CREATE TABLE changes(value TEXT NOT NULL)");
    destinationDatabase.close();
    let restarted = false;

    const result = await migrateT3DesktopData({
      paths,
      ...supportedMigration,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: true,
      hooks: {
        stopDestinationBackend: async () => {
          const changed = new DatabaseSync(destinationDatabasePath);
          changed.exec("INSERT INTO changes VALUES ('remote-write')");
          changed.close();
        },
        startAndValidateDestinationBackend: async () => undefined,
        reloadDestinationSettings: async () => undefined,
        restartPreviousDestinationBackend: async () => {
          restarted = true;
        },
      },
    });

    assert.deepStrictEqual(result, { status: "blocked", reason: "destination-changed" });
    assert.isTrue(restarted);
    const restoredDestination = new DatabaseSync(destinationDatabasePath, { readOnly: true });
    assert.deepStrictEqual(restoredDestination.prepare("SELECT value FROM changes").all(), [
      { value: "remote-write" },
    ]);
    restoredDestination.close();
  });

  it("aborts if T3 Code reopens during staging", async () => {
    const paths = await makeFixture();
    let processChecks = 0;
    const result = await migrateT3DesktopData({
      paths,
      ...supportedMigration,
      processProbe: {
        isPidAlive: () => false,
        isT3DesktopRunning: async () => {
          processChecks += 1;
          return processChecks >= 4;
        },
      },
      migrationManifest: t3MigrationManifest,
      replaceExisting: false,
      hooks: {
        stopDestinationBackend: async () => undefined,
        startAndValidateDestinationBackend: async () => undefined,
        reloadDestinationSettings: async () => undefined,
        restartPreviousDestinationBackend: async () => undefined,
      },
    });

    assert.deepStrictEqual(result, { status: "blocked", reason: "recovery-required" });
    assert.strictEqual(
      await readFile(NodePath.join(paths.sourceStateDir, "environment-id"), "utf8"),
      "source-environment\n",
    );
  });

  it("finalizes a committed migration when its journal remains after a crash", async () => {
    const paths = await makeFixture();
    const runId = "committed-run";
    const sourceBackup = NodePath.join(paths.sourceBaseDir, "hotlap-backups", runId, "userdata");
    const destinationBackup = NodePath.join(paths.migrationDir, "backups", runId, "userdata");
    const stageDir = NodePath.join(paths.migrationDir, "staging", runId, "userdata");
    await mkdir(NodePath.dirname(sourceBackup), { recursive: true });
    await rename(paths.sourceStateDir, sourceBackup);
    await mkdir(paths.destinationStateDir, { recursive: true });
    await writeFile(NodePath.join(paths.destinationStateDir, "imported.txt"), "imported");
    await mkdir(destinationBackup, { recursive: true });
    await writeFile(NodePath.join(destinationBackup, "old.txt"), "old-hotlap");
    await mkdir(paths.migrationDir, { recursive: true });
    await writeFile(
      NodePath.join(paths.migrationDir, "journal.json"),
      JSON.stringify({
        version: 1,
        runId,
        phase: "destination-activated",
        sourceBackup,
        destinationBackup,
        stageDir,
      }),
    );
    await writeFile(
      NodePath.join(paths.migrationDir, "completed.json"),
      JSON.stringify({
        version: 1,
        completedAt: "2026-09-13T00:00:00.000Z",
        pairingTransfer: "preserved",
        sourceStateDir: paths.sourceStateDir,
        sourceBackup,
        destinationBackup,
      }),
    );

    const recovery = await recoverT3DesktopMigration(paths);

    assert.strictEqual(recovery.status, "recovered");
    assert.strictEqual(
      await readFile(NodePath.join(paths.destinationStateDir, "imported.txt"), "utf8"),
      "imported",
    );
    assert.strictEqual(
      await readFile(NodePath.join(destinationBackup, "old.txt"), "utf8"),
      "old-hotlap",
    );
    assert.strictEqual(
      await readFile(NodePath.join(sourceBackup, "environment-id"), "utf8"),
      "source-environment\n",
    );
    assert(!(await readdir(paths.migrationDir)).includes("journal.json"));
  });

  it("recovers an interrupted activation without deleting colliding data", async () => {
    const paths = await makeFixture();
    await mkdir(paths.migrationDir, { recursive: true });
    const sourceBackup = NodePath.join(paths.sourceBaseDir, "hotlap-backups", "run-1", "userdata");
    const destinationBackup = NodePath.join(paths.migrationDir, "backups", "run-1", "userdata");
    await mkdir(NodePath.dirname(sourceBackup), { recursive: true });
    await mkdir(NodePath.dirname(destinationBackup), { recursive: true });
    await writeFile(NodePath.join(paths.sourceStateDir, "collision.txt"), "new-t3");
    await mkdir(paths.destinationStateDir, { recursive: true });
    await writeFile(NodePath.join(paths.destinationStateDir, "imported.txt"), "imported");
    await mkdir(sourceBackup, { recursive: true });
    await writeFile(NodePath.join(sourceBackup, "source.txt"), "source");
    await mkdir(destinationBackup, { recursive: true });
    await writeFile(NodePath.join(destinationBackup, "old.txt"), "old-hotlap");
    await writeFile(
      NodePath.join(paths.migrationDir, "journal.json"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        phase: "destination-activated",
        sourceBackup,
        destinationBackup,
        stageDir: NodePath.join(paths.migrationDir, "staging", "run-1", "userdata"),
      }),
    );

    const recovery = await recoverT3DesktopMigration(paths);

    assert.strictEqual(recovery.status, "blocked");
    assert.strictEqual(recovery.reason, "recovery-required");
    assert.strictEqual(
      await readFile(NodePath.join(paths.sourceStateDir, "collision.txt"), "utf8"),
      "new-t3",
    );
    assert.strictEqual(await readFile(NodePath.join(sourceBackup, "source.txt"), "utf8"), "source");
  });
});
