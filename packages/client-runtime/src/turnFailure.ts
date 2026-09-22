/**
 * How a client headlines a failed turn. The provider's own sentence is the
 * detail; the headline answers "what now?" from the typed kind, and a usage
 * limit names the absolute reset time, which stays true however long the
 * thread sits open (a countdown would go stale without repainting).
 *
 * @module turnFailure
 */
import { type TurnFailureReason, turnFailureReasonForSession } from "@t3tools/contracts";

const RESET_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function turnFailureHeadline(
  reason: TurnFailureReason,
  formatTime: (epochMs: number) => string = (epochMs) => RESET_TIME.format(epochMs),
): string {
  const on = reason.providerInstanceId ? ` on ${reason.providerInstanceId}` : "";
  switch (reason.kind) {
    case "usage_limit": {
      const resetMs = reason.resetsAt ? Date.parse(reason.resetsAt) : Number.NaN;
      return Number.isFinite(resetMs)
        ? `Usage limit reached${on}, resets at ${formatTime(resetMs)}`
        : `Usage limit reached${on}`;
    }
    case "auth":
      return `Sign-in needed${on}`;
    case "session_resume":
      return "The provider session could not resume";
    case "provider_crash":
      return "The provider stopped unexpectedly";
    case "unknown":
      return "The turn failed";
  }
}

/** The headline for a session's current error, whatever wrote it. */
export function turnFailureHeadlineForSession(
  session: Parameters<typeof turnFailureReasonForSession>[0],
): string {
  const reason = turnFailureReasonForSession(session);
  return reason ? turnFailureHeadline(reason) : "The turn failed";
}
