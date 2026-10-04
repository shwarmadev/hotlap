import type {
  OrchestrationLatestTurnState,
  OrchestrationSession,
  ProviderDriverKind,
} from "@t3tools/contracts";

const idleSessionStatuses = new Set<OrchestrationSession["status"]>([
  "ready",
  "idle",
  "interrupted",
  "error",
]);

export function canStopThreadSessionIfIdle(input: {
  readonly expectedProviderName: ProviderDriverKind;
  readonly expectedProviderSessionId: string;
  readonly session: OrchestrationSession | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly hasQueuedTurnStart: boolean;
  readonly hasPendingRequests: boolean;
  readonly backgroundLiveness: "working" | "monitoring" | null;
}): boolean {
  return (
    input.session !== null &&
    input.session.providerName === input.expectedProviderName &&
    input.session.providerSessionId === input.expectedProviderSessionId &&
    idleSessionStatuses.has(input.session.status) &&
    input.session.activeTurnId === null &&
    input.latestTurnState !== "running" &&
    !input.hasQueuedTurnStart &&
    !input.hasPendingRequests &&
    input.backgroundLiveness === null
  );
}
