/**
 * Why a provider turn failed, in a shape a client can render without parsing
 * prose. Adapters classify (they are the only layer that knows what a
 * provider's error sentence means); orchestration carries the reason onto the
 * thread's session and latest turn; clients read `kind` for the headline and
 * `resetsAt` for the one detail a usage limit always has and prose always
 * loses.
 *
 * Lives in its own module because both `providerRuntime.ts` (adapter events)
 * and `orchestration.ts` (thread read model) need it, and `providerRuntime`
 * already imports `orchestration`.
 *
 * @module turnFailure
 */
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Coarse on purpose: each value answers a different "what do I do now?", and a
 * kind nobody can act on differently is noise. `unknown` is the honest bucket
 * for a provider sentence we could not place, and still carries its message.
 */
export const TurnFailureKind = Schema.Literals([
  /** The account's usage window is exhausted. `resetsAt` when reported. */
  "usage_limit",
  /** Credentials are missing, expired, or rejected. */
  "auth",
  /** The provider refused to resume the thread's native session. */
  "session_resume",
  /** The provider process died or the transport dropped mid-turn. */
  "provider_crash",
  /** Classified nowhere; `message` is still the provider's own sentence. */
  "unknown",
]);
export type TurnFailureKind = typeof TurnFailureKind.Type;

export const TurnFailureReason = Schema.Struct({
  kind: TurnFailureKind,
  /** One sentence, already client-safe, shown verbatim. */
  message: TrimmedNonEmptyString,
  /** When the exhausted window reopens, if the provider said so. */
  resetsAt: Schema.optional(IsoDateTime),
  /** The instance that failed. A switch changes it, so the turn names it. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type TurnFailureReason = typeof TurnFailureReason.Type;

/**
 * The reason an errored turn shows, read from the session that recorded the
 * failure: the turn keeps the state, the session keeps the why. The untyped
 * branch covers sessions written before `lastErrorReason` existed, so a turn in
 * `error` state never renders without a reason. Shared by the server's
 * projections and the clients' reducer so they cannot disagree.
 */
export function turnFailureReasonForSession(
  session:
    | {
        readonly lastError: string | null;
        readonly lastErrorReason?: TurnFailureReason | null | undefined;
      }
    | null
    | undefined,
): TurnFailureReason | null {
  if (!session?.lastError) return null;
  // A writer that replaces lastError but spreads the old session keeps the old
  // reason; trusting it would show a previous failure's reason for this one.
  if (
    session.lastErrorReason != null &&
    session.lastErrorReason.message === session.lastError.trim()
  ) {
    return session.lastErrorReason;
  }
  return { kind: "unknown", message: session.lastError };
}

export function turnFailureReasonsEqual(
  left: TurnFailureReason | null | undefined,
  right: TurnFailureReason | null | undefined,
): boolean {
  if (left == null || right == null) return (left ?? null) === (right ?? null);
  return (
    left.kind === right.kind &&
    left.message === right.message &&
    left.resetsAt === right.resetsAt &&
    left.providerInstanceId === right.providerInstanceId
  );
}
