/**
 * The T3 MCP credential each thread's provider session should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export interface McpProviderSessionHandoff {
  readonly target: McpProviderSessionConfig;
  readonly previous: McpProviderSessionConfig | undefined;
}

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /** Installs `target` and remembers the config it replaced so a failed start can restore it. */
    readonly beginHandoff: (
      target: McpProviderSessionConfig,
    ) => Effect.Effect<McpProviderSessionHandoff>;
    /**
     * Restores the replaced config only while the handoff's target is still
     * current; a newer staged config survives. Returns whether it rolled back.
     */
    readonly rollbackHandoff: (handoff: McpProviderSessionHandoff) => Effect.Effect<boolean>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    beginHandoff: (target) =>
      Ref.modify(sessions, (current) => [
        { target, previous: current.get(target.threadId) },
        new Map(current).set(target.threadId, target),
      ]),
    rollbackHandoff: (handoff) =>
      Ref.modify(sessions, (current) => {
        const threadId = handoff.target.threadId;
        if (current.get(threadId)?.providerSessionId !== handoff.target.providerSessionId) {
          return [false, current];
        }
        const next = new Map(current);
        if (handoff.previous) {
          next.set(threadId, handoff.previous);
        } else {
          next.delete(threadId);
        }
        return [true, next];
      }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
