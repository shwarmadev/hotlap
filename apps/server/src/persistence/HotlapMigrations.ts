import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0001 from "./HotlapMigrations/001_ProjectionThreadForks.ts";
import Migration0002 from "./HotlapMigrations/002_ProjectionThreadProviderRoutingMode.ts";
import Migration0003 from "./HotlapMigrations/003_ProjectionThreadSessionLastErrorReason.ts";

type MigrationManifest = ReadonlyArray<readonly [id: number, name: string]>;
type MigrationRow = {
  readonly migrationId: number;
  readonly name: string;
};

const SHARED_LEDGER = "effect_sql_migrations";
const HOTLAP_LEDGER = "hotlap_sql_migrations";
const LEGACY_FORK_MIGRATION = [52, "ProjectionThreadForks"] as const;

const hotlapMigrationEntries = [
  [1, "ProjectionThreadForks", Migration0001],
  [2, "ProjectionThreadProviderRoutingMode", Migration0002],
  [3, "ProjectionThreadSessionLastErrorReason", Migration0003],
] as const;
const hotlapMigrationManifest = hotlapMigrationEntries.map(([id, name]) => [id, name] as const);

export class MigrationLedgerError extends Schema.TaggedError<MigrationLedgerError>()(
  "MigrationLedgerError",
  {
    ledger: Schema.String,
    reason: Schema.Literals([
      "non-contiguous",
      "name-mismatch",
      "unexpected-migration",
      "legacy-schema-mismatch",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid ${this.ledger} migration ledger: ${this.detail}`;
  }
}

const readLedger = Effect.fn("readMigrationLedger")(function* (
  ledger: typeof SHARED_LEDGER | typeof HOTLAP_LEDGER,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly exists: number }>`
    SELECT COUNT(*) AS "exists"
    FROM sqlite_master
    WHERE type = 'table' AND name = ${ledger}
  `;
  if (tables[0]?.exists !== 1) return [];

  return yield* sql<MigrationRow>`
    SELECT migration_id AS "migrationId", name
    FROM ${sql(ledger)}
    ORDER BY migration_id
  `.withoutTransform;
});

const validateExactPrefix = (
  ledger: string,
  rows: ReadonlyArray<MigrationRow>,
  manifest: MigrationManifest,
): MigrationLedgerError | undefined => {
  for (const [index, row] of rows.entries()) {
    const expectedId = index + 1;
    if (row.migrationId !== expectedId) {
      return new MigrationLedgerError({
        ledger,
        reason: "non-contiguous",
        detail: `expected migration ${expectedId}, found ${row.migrationId}`,
      });
    }

    const expected = manifest[index];
    if (expected === undefined) {
      return new MigrationLedgerError({
        ledger,
        reason: "unexpected-migration",
        detail: `migration ${row.migrationId}_${row.name} is not recognized`,
      });
    }
    if (row.name !== expected[1]) {
      return new MigrationLedgerError({
        ledger,
        reason: "name-mismatch",
        detail: `expected ${expected[0]}_${expected[1]}, found ${row.migrationId}_${row.name}`,
      });
    }
  }
};

const validateSharedLedger = (
  rows: ReadonlyArray<MigrationRow>,
  upstreamManifest: MigrationManifest,
): MigrationLedgerError | undefined => {
  const legacy = rows.at(-1);
  const hasExactLegacyMigration =
    rows.length === LEGACY_FORK_MIGRATION[0] &&
    legacy?.migrationId === LEGACY_FORK_MIGRATION[0] &&
    legacy.name === LEGACY_FORK_MIGRATION[1];
  return validateExactPrefix(
    SHARED_LEDGER,
    hasExactLegacyMigration ? rows.slice(0, -1) : rows,
    upstreamManifest,
  );
};

export const prepareMigrationLedgers = Effect.fn("prepareMigrationLedgers")(function* (
  upstreamManifest: MigrationManifest,
) {
  const sql = yield* SqlClient.SqlClient;
  const sharedRows = yield* readLedger(SHARED_LEDGER);
  const hotlapRows = yield* readLedger(HOTLAP_LEDGER);

  const sharedError = validateSharedLedger(sharedRows, upstreamManifest);
  if (sharedError !== undefined) return yield* sharedError;
  const hotlapError = validateExactPrefix(HOTLAP_LEDGER, hotlapRows, hotlapMigrationManifest);
  if (hotlapError !== undefined) return yield* hotlapError;

  const legacy = sharedRows.at(-1);
  const hasExactLegacyMigration =
    legacy?.migrationId === LEGACY_FORK_MIGRATION[0] && legacy.name === LEGACY_FORK_MIGRATION[1];
  if (!hasExactLegacyMigration) return;

  const columns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
  }>`PRAGMA table_info(projection_threads)`;
  const expectedColumns = ["fork_source_thread_id", "fork_source_message_id"];
  const invalidColumns = expectedColumns.filter((name) => {
    const column = columns.find((candidate) => candidate.name === name);
    return column === undefined || column.type.toUpperCase() !== "TEXT" || column.notnull !== 0;
  });
  if (invalidColumns.length > 0) {
    return yield* new MigrationLedgerError({
      ledger: SHARED_LEDGER,
      reason: "legacy-schema-mismatch",
      detail: `legacy 52_ProjectionThreadForks has missing or incompatible columns: ${invalidColumns.join(", ")}`,
    });
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS hotlap_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      if (hotlapRows.length === 0) {
        yield* sql`
          INSERT INTO hotlap_sql_migrations (migration_id, name)
          VALUES (1, 'ProjectionThreadForks')
        `;
      }
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id = 52 AND name = 'ProjectionThreadForks'
      `;
    }),
  );
});

const run = Migrator.make({});
const loader = Migrator.fromRecord(
  Object.fromEntries(
    hotlapMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

export const runHotlapMigrations = Effect.fn("runHotlapMigrations")(function* () {
  const executedMigrations = yield* run({ loader, table: HOTLAP_LEDGER });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Hotlap database schema is current")
    : Effect.log("Hotlap migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
