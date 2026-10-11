import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ProviderRuntimeIngestion asks "does this turn have an assistant message
  // yet?" on streaming events. The only usable index narrowed by thread, so a
  // long thread scanned every message row (text included) and froze the host
  // for up to a minute. This index answers the lookup from the index alone.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_turn_role_streaming
    ON projection_thread_messages(thread_id, turn_id, role, is_streaming)
  `;
});
