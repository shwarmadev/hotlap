import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  ProviderSessionId,
  EnvironmentAuthenticatedPrincipal,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ReadableTranscriptService from "./ReadableTranscriptService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { getReadableThreadTranscript, stopIdleCodexSession } from "./http.ts";

const threadId = ThreadId.make("hotlap-http-thread");
const principal = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("hotlap-test-session"),
    subject: "test",
    method: "bearer-access-token",
    scopes: new Set(scopes),
  });
const command = {
  type: "thread.session.stop",
  commandId: CommandId.make("guarded-stop-http"),
  threadId,
  createdAt: "2026-10-08T00:00:00.000Z",
  onlyIfIdle: true,
  snapshotSequence: 42,
  expectedProviderName: "codex",
  expectedProviderSessionId: "runtime-exact-id",
} as const;

it.effect.each([false, true])(
  "returns the guarded dispatch result without retouching a later runtime (rejected=$0)",
  (projectionRejected) =>
    Effect.gen(function* () {
      if (!projectionRejected) {
        assert.deepEqual(yield* stopIdleCodexSession(command), { sequence: 43 });
        return;
      }
      const error = yield* stopIdleCodexSession(command).pipe(Effect.flip);
      if (error._tag !== "EnvironmentRequestInvalidError")
        throw new Error("Expected typed rejection");
      assert.equal(error.reason, "guarded_session_stop_rejected");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          principal([AuthOrchestrationOperateScope]),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (input) => {
              assert.equal(input.type, "provider-session.detach");
              if (input.type === "provider-session.detach") {
                assert.equal(
                  input.providerSessionId,
                  ProviderSessionId.make(command.expectedProviderSessionId),
                );
                assert.deepEqual(input.idleGuard, {
                  snapshotSequence: 42,
                  expectedProviderName: "codex",
                });
              }
              return projectionRejected
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: input.type,
                      cause: "stale snapshot",
                    }),
                  )
                : Effect.succeed({ sequence: 43, storedEvents: [] });
            },
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            releaseIfIdle: () =>
              Effect.die("HTTP must not release a replacement after the guarded dispatch"),
          }),
        ),
      ),
    ),
);

it.effect("does not call transcript storage without orchestration read permission", () =>
  Effect.gen(function* () {
    const error = yield* getReadableThreadTranscript(threadId).pipe(Effect.flip);
    assert.equal(error._tag, "EnvironmentScopeRequiredError");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        principal([]),
        Layer.succeed(ReadableTranscriptService.ReadableTranscriptService, {
          get: () => Effect.die("unauthorized storage read"),
        }),
      ),
    ),
  ),
);

it.effect.each([
  new ReadableTranscriptService.ReadableTranscriptNotFoundError({ threadId }),
  new ReadableTranscriptService.ReadableTranscriptTooLargeError({ threadId }),
])("maps transcript $0 to typed HTTP failure", (cause) =>
  Effect.gen(function* () {
    const error = yield* getReadableThreadTranscript(threadId).pipe(Effect.flip);
    assert.equal(
      error._tag,
      cause._tag === "ReadableTranscriptNotFoundError"
        ? "EnvironmentResourceNotFoundError"
        : "EnvironmentPayloadTooLargeError",
    );
    assert.equal(
      error.code,
      cause._tag === "ReadableTranscriptNotFoundError" ? "not_found" : "payload_too_large",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        principal([AuthOrchestrationReadScope]),
        Layer.succeed(ReadableTranscriptService.ReadableTranscriptService, {
          get: () => Effect.fail(cause),
        }),
      ),
    ),
  ),
);
