/**
 * Turns a provider's failure sentence into a {@link TurnFailureReason}.
 *
 * An adapter that knows the provider's own error taxonomy should build the
 * reason itself and pass it through; this is the floor under everything else,
 * so that a turn ending in error always carries a kind and a message instead
 * of a bare "error" the client has to apologise for.
 *
 * @module provider/turnFailureReason
 */
import type { ProviderInstanceId, TurnFailureKind, TurnFailureReason } from "@t3tools/contracts";

/**
 * Ordered: the first pattern that matches wins, so the more specific
 * conditions come before the ones whose vocabulary they borrow ("rate limit"
 * also contains "limit"; a crashed process also mentions "session").
 */
const KIND_PATTERNS: ReadonlyArray<readonly [TurnFailureKind, RegExp]> = [
  [
    "usage_limit",
    /\b(usage limit|rate[- ]limit(ed)?|quota|out of credits|credits? (are )?depleted|spend limit|too many requests|429)\b/i,
  ],
  [
    "auth",
    /\b(could not authenticate|unauthori[sz]ed|unauthenticated|authentication (failed|required)|not (logged|signed) in|signed out|invalid api key|expired (token|credential|session token)|re-?authenticate|please (log|sign) in|auth login|401)\b/i,
  ],
  [
    "session_resume",
    /\b((could not|cannot|failed to) resume (the |this )?(session|conversation|thread)|resume state is incompatible|(session|conversation|thread) (was )?not found|no (session|conversation|thread) found|no rollout found|unknown (session|conversation|thread))\b/i,
  ],
  [
    "provider_crash",
    /\b(exited|crashed?|terminated|was killed|closed unexpectedly|broken pipe|EPIPE|ECONNRESET|failed to spawn|spawn \S+ ENOENT)\b/i,
  ],
];

/** The kind a provider sentence reads as, or `unknown` when it reads as nothing. */
export function classifyTurnFailureKind(message: string): TurnFailureKind {
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return "unknown";
}

/**
 * The reason a turn failure carries downstream. `reason` is the adapter's own
 * classification and always wins; `message` is the fallback sentence, and a
 * turn that failed without one still gets a reason rather than nothing.
 */
export function resolveTurnFailureReason(input: {
  readonly reason?: TurnFailureReason | undefined;
  readonly message?: string | null | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}): TurnFailureReason | undefined {
  if (input.reason) {
    return input.providerInstanceId !== undefined && input.reason.providerInstanceId === undefined
      ? { ...input.reason, providerInstanceId: input.providerInstanceId }
      : input.reason;
  }
  const message = input.message?.trim();
  if (!message) return undefined;
  return {
    kind: classifyTurnFailureKind(message),
    message,
    ...(input.providerInstanceId !== undefined
      ? { providerInstanceId: input.providerInstanceId }
      : {}),
  };
}
