import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runHotlapMigrations, runMigrations } from "../Migrations.ts";
import { ProjectionThreadSessionRepositoryLive } from "../Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";

const layer = ProjectionThreadSessionRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.layer(layer)("003_ProjectionThreadSessionLastErrorReason", (it) => {
  it.effect("keeps pre-existing sessions reasonless and round-trips a typed reason", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-old', 'error', 'codex', 'full-access', NULL, 'Turn failed',
          '2026-09-21T01:10:00.000Z'
        )
      `;
      yield* runHotlapMigrations();
      // Idempotent: a second run must not try to add the column again.
      yield* runHotlapMigrations();

      const repository = yield* ProjectionThreadSessionRepository;
      const old = yield* repository.getByThreadId({ threadId: ThreadId.make("thread-old") });
      assert.strictEqual(Option.getOrThrow(old).lastErrorReason, null);

      const reason = {
        kind: "usage_limit" as const,
        message: "Codex usage limit reached. The weekly limit resets in 32m.",
        resetsAt: "2026-09-21T01:42:00.000Z",
        providerInstanceId: ProviderInstanceId.make("codex"),
      };
      yield* repository.upsert({
        threadId: ThreadId.make("thread-new"),
        status: "error",
        providerName: "codex",
        providerSessionId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: reason.message,
        lastErrorReason: reason,
        updatedAt: "2026-09-21T01:10:00.000Z",
      });
      const stored = yield* repository.getByThreadId({ threadId: ThreadId.make("thread-new") });
      assert.deepEqual(Option.getOrThrow(stored).lastErrorReason, reason);
    }),
  );
});
