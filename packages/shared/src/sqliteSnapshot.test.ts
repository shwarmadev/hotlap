import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./nodeSqliteClient.ts";
import { snapshotSqliteDatabase } from "./sqliteSnapshot.ts";

describe("snapshotSqliteDatabase", () => {
  it.effect("includes committed WAL data in one consistent destination database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-snapshot-",
      });
      const sourcePath = path.join(directory, "source.sqlite");
      const destinationPath = path.join(directory, "snapshot.sqlite");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`PRAGMA wal_autocheckpoint = 0`;
        yield* sql`CREATE TABLE entries(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO entries(value) VALUES (${"committed-in-wal"})`;
        expect(yield* fileSystem.exists(`${sourcePath}-wal`)).toBe(true);

        yield* snapshotSqliteDatabase({ sourcePath, destinationPath });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly value: string }>`SELECT value FROM entries`;
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: destinationPath, readonly: true })),
      );

      expect(rows).toEqual([{ value: "committed-in-wal" }]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns a typed error without creating a missing source database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-snapshot-missing-",
      });
      const sourcePath = path.join(directory, "missing.sqlite");
      const destinationPath = path.join(directory, "snapshot.sqlite");

      const error = yield* snapshotSqliteDatabase({ sourcePath, destinationPath }).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("SqliteSnapshotError");
      expect(error.sourcePath).toBe(sourcePath);
      expect(error.destinationPath).toBe(destinationPath);
      expect(yield* fileSystem.exists(sourcePath)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not overwrite an existing destination", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-snapshot-existing-",
      });
      const sourcePath = path.join(directory, "source.sqlite");
      const destinationPath = path.join(directory, "snapshot.sqlite");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE entries(value TEXT NOT NULL)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));
      yield* fileSystem.writeFileString(destinationPath, "keep-me");

      const error = yield* snapshotSqliteDatabase({ sourcePath, destinationPath }).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("SqliteSnapshotError");
      expect(yield* fileSystem.readFileString(destinationPath)).toBe("keep-me");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
