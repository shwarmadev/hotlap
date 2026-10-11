import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shipped as a hotfix for the pre-V2 host (v0.0.50-nightly.20261001.50),
  // where ProviderRuntimeIngestion's per-turn assistant-message lookup scanned
  // whole threads. V2 no longer runs that lookup; this entry keeps the Hotlap
  // ledger identical on databases that took the hotfix. Drop the index in a
  // later Hotlap migration once the legacy table goes.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_turn_role_streaming
    ON projection_thread_messages(thread_id, turn_id, role, is_streaming)
  `;
});
