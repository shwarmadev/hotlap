import type { OrchestrationReadableThreadTranscript, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

const DEFAULT_THREAD_TRANSCRIPT_TIMEOUT_MS = 60_000;

export const fetchEnvironmentThreadTranscript = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadTranscript",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(
        httpBaseUrl,
        `/api/orchestration/threads/${input.threadId}/transcript`,
      ),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_TRANSCRIPT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadTranscript({
        params: { threadId: input.threadId },
        headers,
      }),
  });
});

export type ThreadTranscriptLoadError = RemoteEnvironmentRequestError;

export class ThreadTranscriptLoader extends Context.Service<
  ThreadTranscriptLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationReadableThreadTranscript, ThreadTranscriptLoadError>;
  }
>()("@t3tools/client-runtime/state/threadTranscriptHttp/ThreadTranscriptLoader") {}

export const threadTranscriptLoaderLayer: Layer.Layer<
  ThreadTranscriptLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadTranscriptLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return ThreadTranscriptLoader.of({
      load: (prepared, threadId) =>
        fetchEnvironmentThreadTranscript({
          prepared,
          threadId,
          signer,
          remoteAuthorization,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    });
  }),
);

export class ThreadTranscriptConnectionNotReadyError extends Data.TaggedError(
  "ThreadTranscriptConnectionNotReadyError",
)<{ readonly message: string }> {}

export function createThreadTranscriptCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadTranscriptLoader | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:threads:transcript",
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
    execute: (input: { readonly threadId: ThreadId }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const loader = yield* ThreadTranscriptLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new ThreadTranscriptConnectionNotReadyError({
            message: "The environment HTTP connection is not ready.",
          });
        }
        return yield* loader.load(prepared.value, input.threadId);
      }),
  });
}
