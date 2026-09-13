import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map(({ name }) => name));
  if (!names.has("fork_source_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_source_thread_id TEXT`;
  }
  if (!names.has("fork_source_message_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_source_message_id TEXT`;
  }
});
