import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessInvokedAs,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import { findWindowsShim, repointLauncher, resolveLauncherPath, runUpdate } from "./update.ts";
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("prefers the installer custom bin while retaining its legacy alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-custom-shim-" });
      const executable = path.join(root, "runtime/t3.exe");
      const hotlap = path.join(root, "custom hotlap");
      const legacy = path.join(root, "legacy");
      for (const directory of [hotlap, legacy]) {
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(
          path.join(directory, "hotlap.cmd"),
          `@echo off\r\n"${executable}" %*`,
        );
      }
      const lookup = (environment: NodeJS.ProcessEnv) =>
        findWindowsShim(executable).pipe(
          Effect.provideService(HostProcessEnvironment, environment),
        );
      assert.equal(
        yield* lookup({ HOTLAP_INSTALL_BIN_DIR: hotlap, T3CODE_INSTALL_BIN_DIR: legacy, PATH: "" }),
        path.join(hotlap, "hotlap.cmd"),
      );
      assert.equal(
        yield* lookup({ T3CODE_INSTALL_BIN_DIR: legacy, PATH: "" }),
        path.join(legacy, "hotlap.cmd"),
      );
    }).pipe(Effect.scoped),
  );
  it.effect("finds only the Hotlap Windows shim without touching a T3 installation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-windows-shim-" });
      const executable = path.join(root, "runtime/versions/1.2.3/t3.exe");
      const shim = path.join(root, "hotlap.cmd");
      const contents = `@echo off\r\n"${executable}" %*`;
      yield* fs.writeFileString(path.join(root, "t3.cmd"), contents);
      const lookup = findWindowsShim(executable).pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: root }),
      );
      assert.isUndefined(yield* lookup);
      yield* fs.writeFileString(shim, contents);
      assert.equal(yield* lookup, shim);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "updates an npm CLI using the existing npm runtime without changing unrelated launchers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "hotlap-npm-update-" });
        const runtime = path.join(root, "runtime/versions/9.9.9");
        const entry = path.join(runtime, "node_modules/hotlap/dist/bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "export {};\n");
        yield* fs.writeFileString(path.join(runtime, ".install-complete"), "9.9.9\n");
        const commands: string[] = [];
        yield* runUpdate({
          baseDir: root,
          logsDir: path.join(root, "logs"),
          serverRuntimeStatePath: path.join(root, "missing-runtime.json"),
          channel: undefined,
          requestedVersion: "9.9.9",
          allowDowngrade: false,
          assumeYes: false,
        }).pipe(
          Effect.provideService(HostProcessIsExecutable, false),
          Effect.provideService(HostProcessExecutablePath, "/custom/node"),
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no archive download expected")),
          ),
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            ProcessRunner.ProcessRunner.of({
              run: (input) =>
                Effect.sync(() => {
                  commands.push(input.command);
                  assert.deepEqual(input.args, [entry, "--version"]);
                  return {
                    stdout: "Hotlap v9.9.9\n",
                    stderr: "",
                    code: ChildProcessSpawner.ExitCode(0),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                }),
            }),
          ),
          Effect.provideService(
            BootService.BootService,
            BootService.BootService.of({
              status: Effect.succeed({
                supported: false,
                installed: false,
                current: false,
                unitPath: "",
                logPath: "",
              }),
              install: () => Effect.die("must not install a service"),
              restart: Effect.die("must not restart"),
              uninstall: Effect.die("must not uninstall"),
            }),
          ),
        );
        assert.deepEqual(commands, ["/custom/node"]);
        assert.equal(yield* fs.readFileString(entry), "export {};\n");
        const output = (yield* TestConsole.logLines).join("\n");
        assert.include(output, `'/custom/node' '${entry}'`);
        assert.include(output, `'--base-dir' '${root}'`);
        assert.include(output, "Existing global npm installation was not changed");
        assert.include(output, "npm install -g hotlap@9.9.9");
        assert.notInclude(output, "`t3` launcher");
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      // Another install's versions tree: same shape, different home.
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "./bin/t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});
