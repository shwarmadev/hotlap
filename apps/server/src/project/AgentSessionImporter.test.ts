import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type AgentSessionImportSource,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    reconcileCandidates: () => Stream.empty,
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import", deletedAt: null },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventStore.EventStoreV2)({ read: () => Stream.empty }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          withWriteTransaction: (effect) => effect,
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

const layerDatabase = Sqlite.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProviderSessionRuntime.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerPersistence = Layer.mergeAll(
  layerStores,
  EventSink.layer.pipe(Layer.provide(layerStores)),
);
const originalSource: AgentSessionImportSource = {
  provider: "codex",
  providerInstanceId,
  providerSessionId,
  filePath: "/tmp/native-codex-thread.jsonl",
  size: 100,
  mtimeMs: 2,
  device: 3,
  inode: 4,
  birthtimeMs: 1,
};
const originalThread: AgentSessionScanner.AgentSessionThread = {
  source: "codex",
  providerInstanceId,
  providerSessionId,
  title: "Imported thread",
  model: "gpt-5.4",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant", text: "Old parser text", createdAt: "2026-09-01T10:01:00.000Z" },
    { role: "assistant", text: "Obsolete duplicate", createdAt: "2026-09-01T10:01:00.000Z" },
  ],
};
const correctedSource = {
  ...originalSource,
  parserVersion: AgentSessionScanner.AGENT_SESSION_PARSER_VERSION,
};
const correctedThread = {
  ...originalThread,
  title: "Corrected title",
  messages: originalThread.messages
    .slice(0, 2)
    .map((message) =>
      message.role === "assistant" ? { ...message, text: "Corrected parser text" } : message,
    ),
};

const withRealImport = <A, E, R>(
  body: (input: {
    importer: AgentSessionImporter.AgentSessionImporter["Service"];
    projections: ProjectionStore.ProjectionStoreV2["Service"];
    runtimes: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"];
    sink: EventSink.EventSinkV2["Service"];
    setCandidate: (candidate: AgentSessionScanner.AgentSessionReconcileCandidate) => void;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const sink = yield* EventSink.EventSinkV2;
    let candidate: AgentSessionScanner.AgentSessionReconcileCandidate | undefined;
    const layerImporter = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: (_root, completedSources) =>
              completedSources?.some(
                (source) =>
                  source.parserVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION ||
                  source.parserReviewVersion === AgentSessionScanner.AGENT_SESSION_PARSER_VERSION,
              )
                ? Stream.succeed({ _tag: "AlreadyImported", source: correctedSource })
                : Stream.succeed({
                    _tag: "Importable",
                    source: candidate === undefined ? originalSource : correctedSource,
                    thread:
                      candidate?._tag === "ReplaceImported" ? correctedThread : originalThread,
                  }),
            reconcileCandidates: () =>
              candidate === undefined ? Stream.empty : Stream.succeed(candidate),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (id, fields, filter) =>
              projections
                .getThreadRecords(id, fields, filter)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                  ),
                ),
            getThreadProjection: (id) =>
              projections
                .getThreadProjection(id)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                  ),
                ),
          }),
          IdAllocator.layer,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      return yield* body({
        importer,
        projections,
        runtimes,
        sink,
        setCandidate: (value) => {
          candidate = value;
        },
      });
    }).pipe(Effect.provide(layerImporter));
  }).pipe(Effect.provide(layerPersistence));

it.effect("replaces untouched parser history atomically and removes obsolete messages/items", () =>
  withRealImport(({ importer, projections, runtimes, setCandidate }) =>
    Effect.gen(function* () {
      setCandidate({ _tag: "ReplaceImported", source: correctedSource, thread: correctedThread });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
        repairedCount: 1,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      expect(projection.thread.title).toBe("Corrected title");
      expect(projection.messages.map((message) => message.text)).toEqual([
        "Fix it",
        "Corrected parser text",
      ]);
      expect(projection.turnItems).toHaveLength(2);
      const runtime = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }));
      expect(runtime.status).toBe("stopped");
      expect(runtime.resumeCursor).toEqual({ threadId: providerSessionId });
      setCandidate({ _tag: "PreserveImported", source: correctedSource });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      expect((yield* projections.getThreadProjection(threadId)).messages).toHaveLength(2);
    }),
  ),
);

it.effect("archives a stale imported subagent without losing its history or native binding", () =>
  withRealImport(({ importer, projections, runtimes, setCandidate }) =>
    Effect.gen(function* () {
      setCandidate({ _tag: "ArchiveImported", source: correctedSource });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
        archivedCount: 1,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      expect(projection.thread.archivedAt).not.toBeNull();
      expect(projection.messages).toHaveLength(3);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).resumeCursor).toEqual({
        threadId: providerSessionId,
      });
    }),
  ),
);

it.effect.each([
  "active binding",
  "changed cursor",
  "user metadata",
  "deleted thread",
  "revoked binding",
] as const)("preserves history after %s", (reason) =>
  withRealImport(({ importer, projections, runtimes, sink, setCandidate }) =>
    Effect.gen(function* () {
      const before = yield* projections.getThreadProjection(threadId);
      const runtime = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }));
      if (reason === "active binding") yield* runtimes.upsert({ ...runtime, status: "running" });
      if (reason === "changed cursor")
        yield* runtimes.upsert({ ...runtime, resumeCursor: { threadId: "another-native-thread" } });
      if (reason === "revoked binding") yield* runtimes.deleteByThreadId({ threadId });
      if (reason === "user metadata" || reason === "deleted thread")
        yield* sink.write({
          commandId: CommandId.make("user-command"),
          events: [
            {
              id: EventId.make("user-edited-thread"),
              type: reason === "deleted thread" ? "thread.deleted" : "thread.metadata-updated",
              threadId,
              occurredAt: before.updatedAt,
              payload: {
                ...before.thread,
                ...(reason === "deleted thread"
                  ? { deletedAt: before.updatedAt }
                  : { title: "User title" }),
              },
            },
          ],
        });
      setCandidate({ _tag: "ReplaceImported", source: correctedSource, thread: correctedThread });
      const result = yield* importer.importRecentAgentThreads({ projectId });
      expect(result.repairedCount).toBeUndefined();
      const after = yield* projections.getThreadProjection(threadId);
      expect(after.messages.map((message) => message.text)).toEqual(
        before.messages.map((message) => message.text),
      );
      const binding = yield* runtimes.getByThreadId({ threadId });
      if (reason === "revoked binding") expect(Option.isNone(binding)).toBe(true);
      if (reason === "active binding") expect(Option.getOrThrow(binding).status).toBe("running");
      if (reason === "changed cursor")
        expect(Option.getOrThrow(binding).resumeCursor).toEqual({
          threadId: "another-native-thread",
        });
      if (reason === "user metadata") expect(after.thread.title).toBe("User title");
      if (reason === "deleted thread") expect(after.thread.deletedAt).not.toBeNull();
    }),
  ),
);

it.effect.each([false, true])(
  "audits original V1 import commands before reconciliation (user edited: %s)",
  (edited) =>
    withRealImport(({ importer, projections, setCandidate }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Migrated event IDs alone cannot prove the old user never edited the thread.
        yield* sql`UPDATE orchestration_events SET event_id = replace(event_id, 'agent-session-import:v2:', 'migration:v1:') WHERE stream_id = ${threadId} AND application_event_version = 2`;
        const types = [
          "thread.created",
          "thread.message-sent",
          "thread.settled",
          ...(edited ? ["thread.meta-updated"] : []),
        ];
        for (const [index, type] of types.entries())
          yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version) VALUES (${`legacy-${index}`}, 'thread', ${threadId}, ${index + 1001}, ${type}, '2026-09-01T10:00:00.000Z', 'server', '{}', ${JSON.stringify({ historyImport: !edited || type !== "thread.meta-updated" })}, 1)`;
        setCandidate({ _tag: "ReplaceImported", source: correctedSource, thread: correctedThread });
        const result = yield* importer.importRecentAgentThreads({ projectId });
        const projection = yield* projections.getThreadProjection(threadId);
        if (edited) {
          expect(result.repairedCount).toBeUndefined();
          expect(projection.messages.map((message) => message.text)).toContain("Old parser text");
        } else {
          expect(result.repairedCount).toBe(1);
          expect(projection.messages.map((message) => message.text)).toEqual([
            "Fix it",
            "Corrected parser text",
          ]);
        }
      }),
    ),
);
