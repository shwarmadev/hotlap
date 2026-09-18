import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  THREAD_TRANSCRIPT_MAX_BYTES,
} from "@t3tools/contracts";
import { serializeReadableThreadTranscript } from "@t3tools/shared/readableThreadTranscript";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentTranscriptTooLarge,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const result = yield* projectionSnapshotQuery
            .getThreadTranscriptSource(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (result.overLimit) {
            return yield* failEnvironmentTranscriptTooLarge();
          }
          const source = result.source;
          if (Option.isNone(source)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const transcript = serializeReadableThreadTranscript(source.value.messages);
          if (
            new TextEncoder().encode(transcript.markdown).byteLength > THREAD_TRANSCRIPT_MAX_BYTES
          ) {
            return yield* failEnvironmentTranscriptTooLarge();
          }
          return {
            threadId: source.value.threadId,
            title: source.value.title,
            ...transcript,
          };
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catchTag("OrchestrationGuardedSessionStopRejectedError", () =>
              failEnvironmentInvalidRequest("guarded_session_stop_rejected"),
            ),
            Effect.catchIf(
              (cause) => cause._tag !== "EnvironmentRequestInvalidError",
              (cause) => failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
);
