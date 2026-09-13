import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runHotlapMigrations, runMigrations } from "../Migrations.ts";
import migrateThreadForks from "./001_ProjectionThreadForks.ts";

it.layer(NodeSqliteClient.layerMemory())("001_ProjectionThreadForks", (it) => {
  it.effect("adds nullable lineage without changing existing thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      const now = "2026-09-12T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;

      yield* runHotlapMigrations();
      const rows = yield* sql<{
        readonly sourceThreadId: string | null;
        readonly sourceMessageId: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          fork_source_thread_id AS "sourceThreadId",
          fork_source_message_id AS "sourceMessageId",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ sourceThreadId: null, sourceMessageId: null, updatedAt: now }]);

      yield* sql`
        UPDATE projection_threads
        SET fork_source_thread_id = 'source', fork_source_message_id = 'response'
        WHERE thread_id = 'thread-1'
      `;
      yield* migrateThreadForks;
      const preserved = yield* sql<{
        readonly sourceThreadId: string | null;
        readonly sourceMessageId: string | null;
      }>`
        SELECT
          fork_source_thread_id AS "sourceThreadId",
          fork_source_message_id AS "sourceMessageId"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(preserved, [{ sourceThreadId: "source", sourceMessageId: "response" }]);
    }),
  );
});
