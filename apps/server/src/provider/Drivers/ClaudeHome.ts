import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Every Claude home on one machine can continue another's thread: a resume copies
 * the session transcript into the new home first (see `copyClaudeSession`).
 */
export const CLAUDE_CONTINUATION_GROUP_KEY = "claude:transcript-copy";

/**
 * Copies a session's transcript and its sidecar folder (subagents, tool output)
 * between config dirs, overwriting older copies. Claude Code stores both under
 * `projects/<encoded cwd>/`, so the project folder name carries over unchanged.
 * Returns whether any transcript was found.
 */
export const copyClaudeSession = Effect.fn("copyClaudeSession")(function* (input: {
  readonly fromConfigDir: string;
  readonly toConfigDir: string;
  readonly sessionId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fromProjects = path.join(input.fromConfigDir, "projects");
  // Only a home that never ran Claude has no projects; any other failure is not a
  // missing conversation, which the caller would treat as nothing to resume.
  const projects = yield* fileSystem
    .readDirectory(fromProjects)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed<Array<string>>([]) : Effect.fail(error),
      ),
    );
  let copied = false;
  for (const project of projects) {
    const transcript = path.join(fromProjects, project, `${input.sessionId}.jsonl`);
    if (!(yield* fileSystem.exists(transcript))) continue;
    const targetProject = path.join(input.toConfigDir, "projects", project);
    yield* fileSystem.makeDirectory(targetProject, { recursive: true });
    yield* fileSystem.copyFile(transcript, path.join(targetProject, `${input.sessionId}.jsonl`));
    const sidecar = path.join(fromProjects, project, input.sessionId);
    if (yield* fileSystem.exists(sidecar)) {
      yield* fileSystem.copy(sidecar, path.join(targetProject, input.sessionId), {
        overwrite: true,
      });
    }
    copied = true;
  }
  return copied;
});

const ClaudeGlobalConfig = Schema.fromJsonString(
  Schema.Struct({
    oauthAccount: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          accountUuid: Schema.optional(Schema.String),
          organizationUuid: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
const decodeClaudeGlobalConfig = Schema.decodeUnknownOption(ClaudeGlobalConfig);

/**
 * The subscription login a CLI started with this environment would use, as
 * `account:organization`. A running CLI keeps its login in memory, so a change
 * here (another tool swapping the login) only reaches a new process.
 * Undefined when nobody is signed in with a subscription or the file is unreadable.
 */
export const readClaudeLoginIdentity = Effect.fn("readClaudeLoginIdentity")(function* (
  env: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const globalConfigPath = configured
    ? path.join(path.resolve(configured), ".claude.json")
    : path.join(NodeOS.homedir(), ".claude.json");
  const raw = yield* fileSystem
    .readFileString(globalConfigPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const oauthAccount =
    raw === undefined
      ? undefined
      : Option.getOrUndefined(decodeClaudeGlobalConfig(raw))?.oauthAccount;
  return oauthAccount?.accountUuid
    ? `${oauthAccount.accountUuid}:${oauthAccount.organizationUuid ?? ""}`
    : undefined;
});

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
