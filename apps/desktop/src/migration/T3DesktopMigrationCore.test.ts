// @effect-diagnostics nodeBuiltinImport:off -- Isolated temporary homes exercise the real atomic migration filesystem boundary.
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    await mkdir(NodePath.join(paths.sourceStateDir, "logs"));
    await writeFile(NodePath.join(paths.sourceStateDir, "logs", "server.log"), "omit");

    const lifecycle: string[] = [];
    const result = await migrateT3DesktopData({
      paths,
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
    assert(!(await readdir(paths.destinationStateDir)).includes("logs"));
    const completion = JSON.parse(
      await readFile(NodePath.join(paths.migrationDir, "completed.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.strictEqual(completion.sourceStateDir, paths.sourceStateDir);

    const unknownPaths = await makeFixture();
    await writeFile(NodePath.join(unknownPaths.sourceStateDir, "future-state.bin"), "unknown");
    const unknownResult = await migrateT3DesktopData({
      paths: unknownPaths,
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

    const result = await migrateT3DesktopData({
      paths,
      processProbe: closedProcessProbe,
      migrationManifest: t3MigrationManifest,
      replaceExisting: true,
      hooks: {
        stopDestinationBackend: async () => undefined,
        startAndValidateDestinationBackend: async () => {
          throw new Error("not ready");
        },
        reloadDestinationSettings: async () => undefined,
        restartPreviousDestinationBackend: async () => undefined,
      },
    });

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(
      await readFile(NodePath.join(paths.destinationStateDir, "old.txt"), "utf8"),
      "old-hotlap",
    );
    assert.strictEqual(
      await readFile(NodePath.join(paths.sourceStateDir, "environment-id"), "utf8"),
      "source-environment\n",
    );
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
