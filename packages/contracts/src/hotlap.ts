import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Whether a thread stays on its selected provider instance or may route within its project. */
export const ProviderRoutingMode = Schema.Literals(["fixed", "auto"]);
export type ProviderRoutingMode = typeof ProviderRoutingMode.Type;

/**
 * The only details a server writes on `provider.account.route.failed` activities.
 * Clients show a detail only when it is one of these; anything else (older servers,
 * raw provider errors) is replaced with a generic description.
 */
export const PROVIDER_ACCOUNT_ROUTE_FAILURE_DETAILS = {
  notConfigured: "Automatic switching is not fully configured. The message was not sent.",
  noEligibleAccount: "No eligible provider account is available. The message was not sent.",
  // The server may append when the soonest account resets; clients match on the prefix.
  allAccountsLimited:
    "Every account in this project is at its usage limit, so the message was not sent.",
  targetStartFailed: "The other provider account could not be started.",
  noTargetStarted: "No eligible provider account could be started.",
  commitFailed: "The provider account switch could not be saved.",
} as const;

export const THREAD_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
export const THREAD_FORK_MAX_MESSAGES = 400;
export const THREAD_FORK_MAX_BYTES = 4 * 1024 * 1024;

export const OrchestrationReadableThreadTranscript = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  // The server enforces the byte limit before responding. Keep the shared
  // client schema free of TextEncoder so it is safe to evaluate in Hermes.
  markdown: Schema.String.check(Schema.isMaxLength(THREAD_TRANSCRIPT_MAX_BYTES)),
  messageCount: NonNegativeInt,
});
export type OrchestrationReadableThreadTranscript =
  typeof OrchestrationReadableThreadTranscript.Type;

/** Maintenance clients must provide the exact idle snapshot and runtime identity. */
export const HotlapGuardedSessionStop = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  onlyIfIdle: Schema.Literal(true),
  snapshotSequence: NonNegativeInt,
  expectedProviderName: Schema.Literal("codex"),
  expectedProviderSessionId: TrimmedNonEmptyString,
});
export type HotlapGuardedSessionStop = typeof HotlapGuardedSessionStop.Type;

export const HotlapMaintenanceSession = Schema.Struct({
  providerName: TrimmedNonEmptyString,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  status: Schema.Literals(["ready", "idle", "running", "connecting", "error"]),
  activeTurnId: Schema.NullOr(Schema.String),
});
export const HotlapMaintenanceLatestTurn = Schema.Struct({
  state: Schema.Literals(["running", "completed", "interrupted", "error"]),
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
