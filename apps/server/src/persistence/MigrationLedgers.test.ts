import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { MigrationLedgerError, runMigrations, runPersistenceMigrations } from "./Migrations.ts";
import migrateThreadForks from "./HotlapMigrations/001_ProjectionThreadForks.ts";

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const expectLedgerFailure = Effect.fn("expectLedgerFailure")(function* (
  effect: Effect.Effect<
    unknown,
    MigrationLedgerError | Migrator.MigrationError | SqlError,
    SqlClient.SqlClient
  >,
) {
  const result = yield* Effect.result(effect);
  assert.isTrue(Result.isFailure(result));
  if (Result.isSuccess(result)) return;
  assert.instanceOf(result.failure, MigrationLedgerError);
  return result.failure;
});

it.effect("records upstream and Hotlap migrations in separate ledgers", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runPersistenceMigrations();

      const upstream = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      const hotlap = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM hotlap_sql_migrations
        ORDER BY migration_id
      `;

      assert.equal(upstream.length, 51);
      assert.deepEqual(upstream.at(-1), {
        migrationId: 51,
        name: "ProjectionThreadMessageContext",
      });
      assert.deepEqual(hotlap, [{ migrationId: 1, name: "ProjectionThreadForks" }]);
    }),
  ),
);

it.effect("upgrades a valid older T3 schema before applying Hotlap migrations", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* runPersistenceMigrations();

      const upstream = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      const hotlap = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM hotlap_sql_migrations
        ORDER BY migration_id
      `;

      assert.deepEqual(upstream.at(-1), {
        migrationId: 51,
        name: "ProjectionThreadMessageContext",
      });
      assert.deepEqual(hotlap, [{ migrationId: 1, name: "ProjectionThreadForks" }]);
    }),
  ),
);

it.effect("adopts an exact legacy fork migration after verifying its columns", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* migrateThreadForks;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (52, 'ProjectionThreadForks', '2026-09-12T00:00:00.000Z')
      `;

      yield* runPersistenceMigrations();

      const shared52 = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 52
      `;
      const hotlap = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM hotlap_sql_migrations
      `;
      assert.deepEqual(shared52, []);
      assert.deepEqual(hotlap, [{ migrationId: 1, name: "ProjectionThreadForks" }]);
    }),
  ),
);

it.effect("rejects a legacy row when the fork columns are missing", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'ProjectionThreadForks')
      `;

      const error = yield* expectLedgerFailure(runPersistenceMigrations());
      assert.equal(error?.reason, "legacy-schema-mismatch");

      const shared52 = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 52
      `;
      assert.deepEqual(shared52, [{ name: "ProjectionThreadForks" }]);
    }),
  ),
);

it.effect("rejects and preserves a foreign shared migration 52", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'UpstreamMigration')
      `;

      const error = yield* expectLedgerFailure(runPersistenceMigrations());
      assert.equal(error?.reason, "unexpected-migration");

      const shared52 = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 52
      `;
      assert.deepEqual(shared52, [{ name: "UpstreamMigration" }]);
    }),
  ),
);

it.effect("rejects gaps in the shared migration ledger", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 50`;

      const error = yield* expectLedgerFailure(runPersistenceMigrations());
      assert.equal(error?.reason, "non-contiguous");
    }),
  ),
);

it.effect("rejects conflicting names in either migration ledger", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runPersistenceMigrations();
      yield* sql`
        UPDATE hotlap_sql_migrations
        SET name = 'ConflictingName'
        WHERE migration_id = 1
      `;

      const error = yield* expectLedgerFailure(runPersistenceMigrations());
      assert.equal(error?.reason, "name-mismatch");
    }),
  ),
);
