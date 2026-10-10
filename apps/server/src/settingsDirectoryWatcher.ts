// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's lazy watcher has no attachment signal.
import * as NodeFileSystem from "node:fs";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Acquires the native watcher before returning; events buffer until consumption. */
export const watchSettingsDirectory = (
  directory: string,
  attach: typeof NodeFileSystem.watch = NodeFileSystem.watch,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.make<string, PlatformError.PlatformError | Cause.Done>();
    const watchError = (cause: unknown) =>
      PlatformError.systemError({
        module: "FileSystem",
        method: "watch",
        _tag: "Unknown",
        pathOrDescriptor: directory,
        cause,
      });
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const watcher = attach(directory, (_event, fileName) => {
            if (fileName !== null) Queue.offerUnsafe(events, fileName.toString());
          });
          watcher.on("error", (cause) =>
            Queue.failCauseUnsafe(events, Cause.fail(watchError(cause))),
          );
          watcher.on("close", () => Queue.endUnsafe(events));
          return watcher;
        },
        catch: watchError,
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    );
    return Stream.fromQueue(events);
  });
