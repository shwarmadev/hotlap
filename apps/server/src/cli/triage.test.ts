import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeServerProcess, resolveTriagePaths } from "./triage.ts";

it.effect.each(["hotlap", "legacy", "flag"] as const)(
  "triage reads and writes only the selected %s profile",
  (source) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-triage-home-" });
      const hotlap = path.join(root, "hotlap");
      const legacy = path.join(root, "legacy");
      const explicit = path.join(root, "explicit");
      const paths = yield* resolveTriagePaths(
        source === "flag" ? Option.some(explicit) : Option.none(),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_HOME: legacy,
                ...(source === "legacy" ? {} : { HOTLAP_HOME: hotlap }),
              },
            }),
          ),
        ),
      );
      const selected = source === "flag" ? explicit : source === "legacy" ? legacy : hotlap;
      assert.equal(paths.baseDir, selected);
      assert.equal(paths.stateDir, path.join(selected, "userdata"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports the version the running server recorded, not the CLI's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-triage-" }),
      "server-runtime.json",
    );
    // The test process stands in for the server, so its pid is alive.
    const state = yield* makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* persistServerRuntimeState({ path: statePath, state });

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version ${packageJson.version})`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("says the server version is unknown when the state file has none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-triage-" }),
      "server-runtime.json",
    );
    // A server from before versions were recorded, such as the 0.0.43 desktop
    // app in #13337.
    yield* fs.writeFileString(
      statePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-09-24T00:08:56.777Z",
      }),
    );

    assert.equal(
      yield* describeServerProcess(statePath),
      `running (pid ${String(process.pid)}, http://127.0.0.1:3773, version not recorded)`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
