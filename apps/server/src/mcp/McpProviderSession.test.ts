import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  beginMcpProviderSessionHandoff,
  clearMcpProviderSession,
  readMcpProviderSession,
  rollbackMcpProviderSessionHandoff,
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "./McpProviderSession.ts";

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
  it("restores the previous config when the replacement fails to start", () => {
    const previous = sessionConfig("session-old", "codex-primary");
    const replacement = sessionConfig("session-new", "codex-secondary");
    beginMcpProviderSessionHandoff(previous);

    const handoff = beginMcpProviderSessionHandoff(replacement);
    expect(readMcpProviderSession(previous.threadId)).toBe(replacement);

    rollbackMcpProviderSessionHandoff(handoff);

    expect(readMcpProviderSession(previous.threadId)).toBe(previous);
    clearMcpProviderSession(previous.threadId);
  });

  it("does not let a late rollback replace a newer staged config", () => {
    const previous = sessionConfig("session-old", "codex-primary");
    const firstReplacement = sessionConfig("session-first", "codex-secondary");
    const latestReplacement = sessionConfig("session-latest", "codex-tertiary");
    beginMcpProviderSessionHandoff(previous);
    const firstHandoff = beginMcpProviderSessionHandoff(firstReplacement);
    beginMcpProviderSessionHandoff(latestReplacement);

    expect(rollbackMcpProviderSessionHandoff(firstHandoff)).toBe(false);
    expect(readMcpProviderSession(previous.threadId)).toBe(latestReplacement);
    clearMcpProviderSession(previous.threadId);
  });
});
