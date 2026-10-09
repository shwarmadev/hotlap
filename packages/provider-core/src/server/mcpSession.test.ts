import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpProviderSessions from "./McpProviderSessions.ts";
import { withAgentDeviceEnvironment, type McpProviderSessionConfig } from "./mcpSession.ts";

const sessionConfig = (
  providerSessionId: string,
  providerInstanceId: string,
): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-handoff"),
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  endpoint: "http://127.0.0.1:43123/mcp",
  browserToolsAvailable: false,
  authorizationHeader: `Bearer ${providerSessionId}`,
  capabilities: new Set(["pull-requests"]),
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("provider session handoff", () => {
  it.effect("restores the previous config when the replacement fails to start", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const previous = sessionConfig("session-old", "codex-primary");
      const replacement = sessionConfig("session-new", "codex-secondary");
      yield* sessions.beginHandoff(previous);

      const handoff = yield* sessions.beginHandoff(replacement);
      expect(yield* sessions.read(previous.threadId)).toBe(replacement);

      yield* sessions.rollbackHandoff(handoff);

      expect(yield* sessions.read(previous.threadId)).toBe(previous);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("does not let a late rollback replace a newer staged config", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const previous = sessionConfig("session-old", "codex-primary");
      const firstReplacement = sessionConfig("session-first", "codex-secondary");
      const latestReplacement = sessionConfig("session-latest", "codex-tertiary");
      yield* sessions.beginHandoff(previous);
      const firstHandoff = yield* sessions.beginHandoff(firstReplacement);
      yield* sessions.beginHandoff(latestReplacement);

      expect(yield* sessions.rollbackHandoff(firstHandoff)).toBe(false);
      expect(yield* sessions.read(previous.threadId)).toBe(latestReplacement);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
