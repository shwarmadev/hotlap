import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some(({ name }) => name === "provider_routing_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN provider_routing_mode TEXT NOT NULL DEFAULT 'fixed'
      CHECK (provider_routing_mode IN ('fixed', 'auto'))
    `;
  }
});
