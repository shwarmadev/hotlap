import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./nodeSqliteClient.ts";

export interface SqliteSnapshotInput {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export class SqliteSnapshotError extends Schema.TaggedError<SqliteSnapshotError>()(
  "SqliteSnapshotError",
  {
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to snapshot SQLite database ${this.sourcePath} to ${this.destinationPath}.`;
  }
}

/**
 * Writes a transactionally consistent SQLite snapshot to a caller-owned path.
 *
 * The source is opened read-only. SQLite's `VACUUM INTO` includes committed WAL
 * data without copying or mutating the source database, WAL, or SHM files.
 */
export const snapshotSqliteDatabase = Effect.fn("sqliteSnapshot.snapshotSqliteDatabase")(
  function* ({ sourcePath, destinationPath }: SqliteSnapshotInput) {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${destinationPath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: sourcePath, readonly: true })),
      Effect.mapError((cause) => new SqliteSnapshotError({ sourcePath, destinationPath, cause })),
    );
  },
);
