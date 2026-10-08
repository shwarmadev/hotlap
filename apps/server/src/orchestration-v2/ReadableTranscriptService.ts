import {
  THREAD_TRANSCRIPT_MAX_BYTES,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationReadableThreadTranscript,
} from "@t3tools/contracts";
import {
  serializeReadableThreadTranscript,
  type ReadableThreadMessageSource,
} from "@t3tools/shared/readableThreadTranscript";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ReadableTranscriptNotFoundError extends Schema.TaggedError<ReadableTranscriptNotFoundError>()(
  "ReadableTranscriptNotFoundError",
  { threadId: ThreadId },
) {}
export class ReadableTranscriptTooLargeError extends Schema.TaggedError<ReadableTranscriptTooLargeError>()(
  "ReadableTranscriptTooLargeError",
  { threadId: ThreadId },
) {}
export class ReadableTranscriptLoadError extends Schema.TaggedError<ReadableTranscriptLoadError>()(
  "ReadableTranscriptLoadError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}
export class ReadableTranscriptService extends Context.Service<
  ReadableTranscriptService,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<
      OrchestrationReadableThreadTranscript,
      | ReadableTranscriptNotFoundError
      | ReadableTranscriptTooLargeError
      | ReadableTranscriptLoadError
    >;
  }
>()("t3/orchestration-v2/ReadableTranscriptService") {}

export function readableProjectionMessages(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ReadableThreadMessageSource> {
  if (projection.visibleTurnItems.length === 0)
    return projection.messages.map((message) => ({
      ...message,
      createdAt: DateTime.formatIso(message.createdAt),
    }));
  return projection.visibleTurnItems.flatMap(({ item }) => {
    if (item.type !== "user_message" && item.type !== "assistant_message") return [];
    return [
      {
        id: item.messageId,
        role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
        text: item.text,
        streaming: item.type === "assistant_message" && item.streaming,
        createdAt: DateTime.formatIso(
          item.startedAt ?? item.completedAt ?? projection.thread.createdAt,
        ),
        ...(item.type === "user_message"
          ? {
              attachments: item.attachments,
              ...(item.context === undefined ? {} : { context: item.context }),
            }
          : {}),
      },
    ];
  });
}

export const layer = Layer.effect(
  ReadableTranscriptService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return ReadableTranscriptService.of({
      get: Effect.fn("ReadableTranscriptService.get")(function* (threadId) {
        const snapshot = yield* threads.getThreadSnapshot(threadId).pipe(
          Effect.mapError((cause) => {
            const detail = cause.cause;
            return typeof detail === "object" &&
              detail !== null &&
              "_tag" in detail &&
              detail._tag === "ProjectionStoreThreadNotFoundError"
              ? new ReadableTranscriptNotFoundError({ threadId })
              : new ReadableTranscriptLoadError({ threadId, cause });
          }),
        );
        // Enforce the cap before materializing a second copy of a large transcript.
        const messages = readableProjectionMessages(snapshot.projection);
        let bytes = 0;
        for (const message of messages) {
          bytes += Buffer.byteLength(message.text, "utf8");
          if (bytes > THREAD_TRANSCRIPT_MAX_BYTES)
            return yield* new ReadableTranscriptTooLargeError({ threadId });
        }
        const transcript = serializeReadableThreadTranscript(messages);
        if (Buffer.byteLength(transcript.markdown, "utf8") > THREAD_TRANSCRIPT_MAX_BYTES)
          return yield* new ReadableTranscriptTooLargeError({ threadId });
        return { threadId, title: snapshot.projection.thread.title, ...transcript };
      }),
    });
  }),
);
