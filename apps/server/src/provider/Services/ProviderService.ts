/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  MessageId,
  ThreadId,
  TurnId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

export interface ProviderSessionStartOptions {
  /**
   * Allows replacing an incompatible provider binding only while orchestration
   * has verified that the thread has never started a turn.
   */
  readonly allowIncompatibleUnstartedReplacement?: true;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    options?: ProviderSessionStartOptions,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly compactThread: (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
    requestId?: MessageId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a session only when the live provider identity still matches.
   *
   * Optional for compatibility with third-party/test service layers. Callers
   * that require compare-and-stop semantics must fail closed when unavailable.
   */
  readonly stopSessionIfCurrent?: (input: {
    readonly threadId: ThreadId;
    readonly expectedProviderName: ProviderDriverKind;
    readonly expectedProviderSessionId: string;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Checks a lifecycle event against the persisted provider binding. Missing
   * or legacy bindings remain authoritative so recovery events are not lost.
   */
  readonly isSessionEventAuthoritative: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, ProviderServiceError>;

  /** Clear a terminal persisted turn only if this instance still owns it. */
  readonly clearActiveTurnIfMatches?: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly turnId: TurnId;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /** Inspect the durable admission slot and clear it only with terminal proof. */
  readonly reconcilePersistedActiveTurn?: (input: {
    readonly threadId: ThreadId;
    readonly terminalTurnIds: ReadonlySet<TurnId>;
  }) => Effect.Effect<
    | { readonly status: "idle" }
    | { readonly status: "active"; readonly turnId: TurnId }
    | { readonly status: "terminal-cleared"; readonly turnId: TurnId },
    ProviderServiceError
  >;

  /**
   * Read the durable provider admission of one message for recovery.
   * `turnId` is null while that send was dispatched but never confirmed.
   */
  readonly getPersistedTurnAdmission?: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    { readonly turnId: TurnId | null; readonly active: boolean } | null,
    ProviderServiceError
  >;

  /**
   * Whether a thread already has a durable provider session to resume. Imported
   * threads carry one before their first turn, and it only resolves inside the
   * account that recorded it, so such a thread cannot be routed elsewhere.
   */
  readonly hasPersistedResumeCursor?: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * Drop the dispatch marker of a send recovery has settled. The marker only has
   * to outlive a crash mid-send, so leaving it behind would refuse a later retry
   * of the same message and grow the durable payload for the session's life.
   */
  readonly clearSettledDispatchMarker?: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /** Clear one exact admitted turn only after its live provider session disappeared. */
  readonly clearOrphanedTurnAdmissionIfMatches?: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly turnId: TurnId;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Reject unsupported rewind before files change, without resuming the session.
   */
  readonly assertConversationRollbackSupported: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
