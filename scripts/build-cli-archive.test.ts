import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { stageWebClient } from "./build-cli-archive.ts";

it.layer(NodeServices.layer)("Hotlap archive web client", (it) => {
  it.effect.each([
    { version: "1.2.3", expectedIcon: "assets/prod/t3-black-web-favicon.ico" },
    { version: "1.2.3-nightly.20260914.1", expectedIcon: "assets/nightly/nightly-web-favicon.ico" },
    { version: "1.2.3-preview.20260914.1", expectedIcon: "assets/nightly/nightly-web-favicon.ico" },
  ] as const)(
    "ships channel branding without changing source assets ($version)",
    ({ version, expectedIcon }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-archive-web-" });
          const source = path.join(root, "source");
          const target = path.join(root, "client");
          const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
          yield* fs.makeDirectory(path.join(source, "assets"), { recursive: true });
          yield* fs.writeFileString(path.join(source, "favicon.ico"), "development icon");
          yield* fs.writeFileString(path.join(source, "index.html"), "Hotlap web client");
          yield* fs.writeFileString(path.join(source, "assets/app.js.map"), "source map");

          yield* stageWebClient(source, target, version);

          const actualIcon = yield* fs.readFile(path.join(target, "favicon.ico"));
          const releaseIcon = yield* fs.readFile(path.join(repoRoot, expectedIcon));
          assert.isTrue(Buffer.from(actualIcon).equals(releaseIcon));
          assert.equal(
            yield* fs.readFileString(path.join(source, "favicon.ico")),
            "development icon",
          );
          assert.equal(
            yield* fs.readFileString(path.join(target, "index.html")),
            "Hotlap web client",
          );
          assert.isFalse(yield* fs.exists(path.join(target, "assets/app.js.map")));
          assert.isTrue(yield* fs.exists(path.join(source, "assets/app.js.map")));
        }),
      ),
  );
});
