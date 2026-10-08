import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";

import { makeCli } from "./binCli.ts";

const cli = makeCli({ cloudEnabled: false });
const runtime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);
const run = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

it.effect("uses Hotlap identity in root and service help", () =>
  Effect.gen(function* () {
    yield* run(["--help"]);
    assert.include((yield* TestConsole.logLines).join("\n"), "Run the Hotlap server.");
    yield* run(["service", "--help"]);
    const help = (yield* TestConsole.logLines).join("\n");
    assert.include(help, "Manage the Hotlap background service.");
    for (const command of ["install", "uninstall", "status"]) assert.include(help, command);
  }).pipe(Effect.provide(runtime)),
);

it.effect("reports missing cloud configuration under the Hotlap command path", () =>
  Effect.gen(function* () {
    const error = yield* run(["connect", "status"]).pipe(Effect.flip);
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") assert.fail("Expected ShowHelp");
    assert.deepEqual(error.commandPath, ["hotlap", "connect"]);
    assert.include(error.errors[0]?.message ?? "", "missing T3 Connect public configuration");
  }).pipe(Effect.provide(runtime)),
);

it.effect.each([
  {
    args: ["auth", "pairing", "create", "--ttl", "soon"],
    path: ["hotlap", "auth", "pairing", "create"],
    tag: "InvalidValue",
  },
  {
    args: ["project", "add", "/unused-test-workspace", "--dev-url", "http://127.0.0.1:5173"],
    path: ["hotlap", "project", "add"],
    tag: "UnrecognizedOption",
  },
])("uses Hotlap command paths for parsing errors: $tag", ({ args, path, tag }) =>
  Effect.gen(function* () {
    const error = yield* run(args).pipe(Effect.flip);
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") assert.fail("Expected ShowHelp");
    assert.deepEqual(error.commandPath, path);
    assert.equal(error.errors[0]?._tag, tag);
  }).pipe(Effect.provide(runtime)),
);
