// @effect-diagnostics-next-line nodeBuiltinImport:off -- Verifies the native watcher's acquisition and release.
import * as NodeFileSystem from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { watchSettingsDirectory } from "./settingsDirectoryWatcher.ts";

it.layer(NodeServices.layer)("settings directory watcher", (it) => {
  it.effect("observes a write immediately after acquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const changes = yield* watchSettingsDirectory(directory);
        yield* fs.writeFileString(path.join(directory, "settings.json"), "{}");
        const change = yield* changes.pipe(
          Stream.filter((fileName) => fileName === "settings.json"),
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        assert.equal(Option.getOrUndefined(change), "settings.json");
      }),
    ).pipe(TestClock.withLive),
  );

  it.effect("attaches before returning and closes when its scope ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const closed = yield* Deferred.make<void>();
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFileSystem.watch(directory)),
          (resource) => Effect.sync(() => resource.close()),
        );
        watcher.once("close", () => Effect.runSync(Deferred.succeed(closed, undefined)));
        let attached = false;
        yield* Effect.scoped(
          watchSettingsDirectory(directory, () => {
            attached = true;
            return watcher;
          }).pipe(
            Effect.tap(() => Effect.sync(() => assert.equal(attached, true))),
            Effect.asVoid,
          ),
        );
        yield* Deferred.await(closed).pipe(Effect.timeout("10 seconds"));
      }),
    ).pipe(TestClock.withLive),
  );

  it.effect("preserves a registration failure and its directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cause = new Error("watch registration failed");
        const failure = yield* watchSettingsDirectory("settings-directory", () => {
          throw cause;
        }).pipe(Effect.flip);
        assert.ok(failure.reason instanceof PlatformError.SystemError);
        assert.equal(failure.reason.method, "watch");
        assert.equal(failure.reason.pathOrDescriptor, "settings-directory");
        assert.equal(failure.reason.cause, cause);
      }),
    ),
  );
});
