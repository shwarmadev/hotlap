/**
 * Threads the usage-limit auto-resume reactor is waiting on. The reactor
 * writes it and the shell query reads it, so lists show Waiting instead of
 * the session's limit error. In memory like ThreadPlanProgress: the reactor
 * rebuilds its waits, and this set, on startup.
 *
 * @module UsageLimitWaitingThreads
 */
import * as Context from "effect/Context";

export const UsageLimitWaitingThreads = Context.Reference<Set<string>>(
  "t3/orchestration/UsageLimitWaitingThreads",
  { defaultValue: () => new Set() },
);
