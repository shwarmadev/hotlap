import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import { readChromiumLocalStorage } from "./chromiumLocalStorage.ts";

vi.mock("./chromiumLocalStorage.ts", () => ({ readChromiumLocalStorage: vi.fn() }));
vi.mock("../electron/ElectronProtocol.ts", () => ({ getDesktopUrl: () => "t3code://app/" }));

it.effect.each([false, true])(
  "imports only Hotlap drafts (Hotlap profile exists: %s)",
  (hasHotlap) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-draft-isolation-" });
      const destination = path.join(directory, "hotlap-v2");
      yield* fs.makeDirectory(destination);
      for (const name of ["t3code", "T3 Code (Alpha)", ...(hasHotlap ? ["hotlap"] : [])]) {
        const source = path.join(directory, name, "Local Storage", "leveldb");
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.writeFileString(path.join(source, "000001.log"), "fixture");
      }
      const read = vi.mocked(readChromiumLocalStorage);
      read.mockReset();
      read.mockReturnValue(Effect.succeed(new Map([["draft", "Hotlap draft"]])));
      const environment = DesktopEnvironment.layer({
        dirname: "/isolated/desktop/dist-electron",
        homeDirectory: "/isolated/home",
        platform: "win32",
        processArch: "x64",
        appVersion: "0.0.0",
        appPath: "/isolated/Hotlap",
        isPackaged: true,
        resourcesPath: "/isolated/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(DesktopConfig.layerTest({ APPDATA: directory })),
      );
      yield* Effect.gen(function* () {
        const importer = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
        yield* importer.load(destination);
        const items = yield* importer.take;
        if (hasHotlap) {
          assert.deepEqual(Option.getOrThrow(items), { draft: "Hotlap draft" });
          assert.equal(
            read.mock.calls[0]?.[0],
            path.join(directory, "hotlap", "Local Storage", "leveldb"),
          );
          assert.isFalse(yield* fs.exists(path.join(destination, "v1-local-storage-imported")));
          yield* importer.complete;
        } else {
          assert.isTrue(Option.isNone(items));
          assert.equal(read.mock.calls.length, 0);
        }
        assert.isTrue(yield* fs.exists(path.join(destination, "v1-local-storage-imported")));
      }).pipe(Effect.provide(DesktopLegacyLocalStorage.layer.pipe(Layer.provide(environment))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
