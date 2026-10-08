import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createThreadTranscriptCommand,
  fetchEnvironmentThreadTranscript,
  ThreadTranscriptConnectionNotReadyError,
  ThreadTranscriptLoader,
} from "./threadTranscriptHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const THREAD_ID = ThreadId.make("thread-1");

describe("fetchEnvironmentThreadTranscript", () => {
  it.effect("loads the complete readable transcript from the prepared environment", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(
          Response.json({
            threadId: THREAD_ID,
            title: "Readable thread",
            markdown: "# Readable thread\n\n## User\n\nHello",
            messageCount: 1,
          }),
        );
      }) satisfies typeof fetch;

      const result = yield* fetchEnvironmentThreadTranscript({
        prepared: PREPARED,
        threadId: THREAD_ID,
        signer: Option.none(),
      }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));

      expect(result).toEqual({
        threadId: THREAD_ID,
        title: "Readable thread",
        markdown: "# Readable thread\n\n## User\n\nHello",
        messageCount: 1,
      });
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe(
        "https://environment.example.test/api/orchestration/threads/thread-1/transcript",
      );
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("include");
    }),
  );

  it.effect("preserves the typed response when the readable transcript is too large", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentPayloadTooLargeError",
              code: "payload_too_large",
              reason: "thread_transcript_too_large",
              traceId: "trace-too-large",
            },
            { status: 413 },
          ),
        )) satisfies typeof fetch;

      const error = yield* fetchEnvironmentThreadTranscript({
        prepared: PREPARED,
        threadId: THREAD_ID,
        signer: Option.none(),
      }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentPayloadTooLargeError",
        reason: "thread_transcript_too_large",
        traceId: "trace-too-large",
      });
    }),
  );

  const EXPECTED = {
    threadId: THREAD_ID,
    title: "Readable thread",
    markdown: "# Readable thread",
    messageCount: 0,
  } as const;

  // Runs the command against one fake environment whose HTTP connection is `prepared`.
  const makeTranscriptCommand = Effect.fn(function* (prepared: Option.Option<PreparedConnection>) {
    const requested: Array<readonly [PreparedConnection, typeof THREAD_ID]> = [];
    const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    });
    const supervisor = EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none()),
      prepared: yield* SubscriptionRef.make(prepared),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor["Service"]);
    const run: EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry["Service"]["followStream"] = (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor);
    const environments = EnvironmentRegistry.of({
      run,
      followStream,
      stateChanges: () => Stream.never,
    } as unknown as EnvironmentRegistry["Service"]);
    const loader = ThreadTranscriptLoader.of({
      load: (connection, threadId) =>
        Effect.sync(() => {
          requested.push([connection, threadId]);
          return EXPECTED;
        }),
    });
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry, environments),
        Layer.succeed(ThreadTranscriptLoader, loader),
      ),
    );
    const command = createThreadTranscriptCommand(runtime);
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
      Effect.sync(() => value.dispose()),
    );
    const load = () =>
      Effect.promise(() =>
        command.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: THREAD_ID },
        }),
      );
    return { load, requested } as const;
  });

  it.effect("loads a fresh transcript through the target environment command", () =>
    Effect.gen(function* () {
      const { load, requested } = yield* makeTranscriptCommand(Option.some(PREPARED));

      const result = yield* load();
      const second = yield* load();

      expect(result).toMatchObject({ _tag: "Success", value: EXPECTED });
      expect(second).toMatchObject({ _tag: "Success", value: EXPECTED });
      expect(requested).toEqual([
        [PREPARED, THREAD_ID],
        [PREPARED, THREAD_ID],
      ]);
    }),
  );

  it.effect("fails without loading when the environment HTTP connection is not ready", () =>
    Effect.gen(function* () {
      const { load, requested } = yield* makeTranscriptCommand(Option.none());

      const result = yield* load();

      if (result._tag !== "Failure") throw new Error("expected the transcript load to fail");
      expect(Cause.squash(result.cause)).toBeInstanceOf(ThreadTranscriptConnectionNotReadyError);
      expect(requested).toEqual([]);
    }),
  );
});
