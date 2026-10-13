/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  AgentSessionImportSource,
  ApprovalRequestId,
  CheckpointRef,
  ComposerContextKind,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadShell,
  ModelSelection,
  ProviderInteractionMode,
  ProviderRoutingMode,
  ProjectId,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  ProjectionPendingTurnStart,
  ProjectionTurnState,
} from "../../persistence/Services/ProjectionTurns.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionEventReplayStats {
  readonly eventCount: number;
  readonly payloadBytes: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * Facts needed to snapshot a thread's workspace for checkpoints. Active threads
 * only, and no message or checkpoint-file reads, so it stays cheap on long threads.
 */
export interface ProjectionThreadCheckpointCaptureContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Null when the project row is gone; the thread worktree may still apply. */
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null;
  readonly activeTurnId: TurnId | null;
  /** Highest checkpoint turn count on the thread, 0 when none. */
  readonly latestCheckpointTurnCount: number;
}

/** One turn's checkpoint row, without its file summary. */
export interface ProjectionTurnCheckpoint {
  readonly checkpointTurnCount: number;
  readonly status: OrchestrationCheckpointSummary["status"];
  readonly assistantMessageId: MessageId | null;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

export interface ProjectionReadableThreadMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly attachments?: ReadonlyArray<{ readonly name: string }>;
  readonly context?: {
    readonly records: ReadonlyArray<{
      readonly contextId: string;
      readonly kind: ComposerContextKind;
      readonly label: string;
    }>;
  };
}

export interface ProjectionThreadTranscriptSource {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly messages: ReadonlyArray<ProjectionReadableThreadMessage>;
}

export type ProjectionBoundedThreadSource<T> =
  | {
      readonly overLimit: true;
    }
  | {
      readonly overLimit: false;
      readonly source: Option.Option<T>;
    };

export interface ProjectionThreadForkSource extends ProjectionThreadTranscriptSource {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly providerRoutingMode?: ProviderRoutingMode;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly busy: boolean;
  readonly selectedTurn: {
    readonly state: string;
    readonly assistantMessageId: MessageId | null;
  } | null;
}

/** The thread fields pull request sync reads, for a thread with at least one link. */
export type ProjectionThreadPullRequests = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "settledOverride" | "settledAt" | "pullRequests"
>;

export interface ProjectionThreadDetailQuery {
  /**
   * Limit activities before SQLite returns and decodes their payloads.
   * Any explicit filter omits pinned-request reads. An empty list also skips
   * the activity query. Omit this option to preserve the full detail response.
   */
  readonly activityKinds?: ReadonlyArray<string>;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /** Read only safe, readable fields for a complete transcript, including archived threads. */
  readonly getThreadTranscriptSource: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ProjectionBoundedThreadSource<ProjectionThreadTranscriptSource>,
    ProjectionRepositoryError
  >;

  /** Resolve and validate the durable source facts needed by a serialized fork command. */
  readonly getThreadForkSource: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    ProjectionBoundedThreadSource<ProjectionThreadForkSource>,
    ProjectionRepositoryError
  >;

  /** Destination-owned copied history for the first provider continuation after a fork. */
  readonly getPendingForkHandoffSource: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ProjectionBoundedThreadSource<ProjectionThreadTranscriptSource>,
    ProjectionRepositoryError
  >;

  /** Read the latest request or resolution without loading the thread history. */
  readonly getUserInputActivity: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
  }) => Effect.Effect<Option.Option<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /**
   * Read every activity of one kind across active (not deleted, not archived)
   * threads, without hydrating the threads. Used at startup to find state a
   * crashed process left behind.
   */
  readonly listActivitiesByKind: (
    kind: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   *
   * `unsettledOnly` is for background sweeps, not clients. It skips settled
   * threads and their sessions, PR links, and turns, and its `updatedAt`
   * ignores those rows. It still resolves every project, which keeps
   * repository identities cached for client connects.
   */
  readonly getShellSnapshot: (options?: {
    readonly unsettledOnly?: boolean;
  }) => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read active (not deleted, not archived) threads that have at least one pull
   * request link, in shell snapshot order. Skips repository identity, so no
   * legacy `linkedPullRequest` is derived.
   */
  readonly listThreadsWithPullRequests: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadPullRequests>,
    ProjectionRepositoryError
  >;

  /** Durable worktree ownership retained after thread deletion, including across restarts. */
  readonly getDeletedWorktreeThreads: () => Effect.Effect<
    ReadonlyArray<{
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly branch: string;
      readonly worktreePath: string;
      readonly workspaceRoot: string;
      readonly deletedAt: string;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Measure a persisted event range without decoding its payload bodies.
   */
  readonly getEventReplayStats: (input: {
    readonly fromSequenceExclusive: number;
    readonly toSequenceInclusive: number;
  }) => Effect.Effect<ProjectionEventReplayStats, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  readonly getProjectShells: (
    projectIds?: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /** Read completed import sources without loading thread history. */
  readonly getImportedAgentSessionSources: (projectId: ProjectId) => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly source: AgentSessionImportSource;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /** Read the narrow context used to capture checkpoints for an active thread. */
  readonly getThreadCheckpointCaptureContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<ProjectionThreadCheckpointCaptureContext>,
    ProjectionRepositoryError
  >;

  /** Read one turn's checkpoint, if it has one. */
  readonly getTurnCheckpoint: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<ProjectionTurnCheckpoint>, ProjectionRepositoryError>;

  /** Read the id of a turn's most recent assistant message. */
  readonly getLatestAssistantMessageIdForTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<Option.Option<MessageId>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /** Read the active thread and session facts used to ingest provider events. */
  readonly getThreadRuntimeContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<
      Pick<OrchestrationThreadShell, "id" | "projectId" | "title" | "titleState" | "session">
    >,
    ProjectionRepositoryError
  >;

  /**
   * Read one requested message and whether another non-compaction user message exists.
   * Newer queued messages count too, preserving first-turn title eligibility.
   */
  readonly getTurnStartMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    Option.Option<{
      readonly message: OrchestrationMessage;
      readonly hasOtherUserMessages: boolean;
    }>,
    ProjectionRepositoryError
  >;

  /** Read the one durable pending provider-turn admission for a thread. */
  readonly getPendingTurnStartByThreadId?: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /** List durable provider-turn admissions that still await a concrete turn. */
  readonly listPendingTurnStarts?: () => Effect.Effect<
    ReadonlyArray<ProjectionPendingTurnStart>,
    ProjectionRepositoryError
  >;

  /** Read the durable lifecycle state for one concrete provider turn. */
  readonly getTurnStateById?: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<Option.Option<ProjectionTurnState>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    query?: ProjectionThreadDetailQuery,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   *
   * Activity payloads are projected for clients as they are read in small
   * sequential batches. Callers still apply the full snapshot projector for
   * collection-level activity pruning.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
