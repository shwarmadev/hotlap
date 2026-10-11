import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runHotlapMigrations, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "003_ProjectionThreadMessagesAssistantTurnIndex",
  (it) => {
    it.effect("serves the assistant-message turn lookup from a covering index", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        yield* runHotlapMigrations();

        const columns = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM pragma_index_info('idx_projection_thread_messages_thread_turn_role_streaming')
          ORDER BY seqno
        `;
        assert.deepEqual(
          columns.map((column) => column.name),
          ["thread_id", "turn_id", "role", "is_streaming"],
        );

        // Same shape as ProjectionThreadMessageRepository.hasAssistantMessageForTurn.
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT EXISTS (
            SELECT 1
            FROM projection_thread_messages
            WHERE thread_id = ${"thread-1"}
              AND turn_id = ${"turn-1"}
              AND role = 'assistant'
              AND (${1} = 0 OR is_streaming = 1)
            LIMIT 1
          ) AS "exists"
        `;
        assert.isTrue(
          plan.some((row) =>
            row.detail.includes(
              "USING COVERING INDEX idx_projection_thread_messages_thread_turn_role_streaming (thread_id=? AND turn_id=? AND role=?)",
            ),
          ),
          plan.map((row) => row.detail).join("\n"),
        );
      }),
    );
  },
);
