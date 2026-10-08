import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runHotlapMigrations, runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "002_ProjectionThreadProviderRoutingMode",
  (it) => {
    it.effect("backfills existing threads as fixed and preserves explicit routing modes", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-09-15T00:00:00Z', '2026-09-15T00:00:00Z'
        )
      `;

        yield* runHotlapMigrations();
        const rows = yield* sql<{ readonly mode: string }>`
        SELECT provider_routing_mode AS mode
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(rows, [{ mode: "fixed" }]);

        yield* sql`
        UPDATE projection_threads SET provider_routing_mode = 'auto'
        WHERE thread_id = 'thread-1'
      `;
        yield* runHotlapMigrations();
        const preserved = yield* sql<{ readonly mode: string }>`
        SELECT provider_routing_mode AS mode
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(preserved, [{ mode: "auto" }]);
      }),
    );
  },
);
