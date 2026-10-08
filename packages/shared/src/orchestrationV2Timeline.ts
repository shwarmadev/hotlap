import type {
  MessageId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status"> & {
  readonly userMessageId?: MessageId;
};
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId"> & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly messageId?: MessageId;
  readonly failure?: Pick<OrchestrationV2ProviderFailure, "class">;
};

/** Reserved IDs identify the provider continuation rather than a user-authored chat turn. */
export function isHotlapUsageLimitContinuationMessageId(messageId: string | undefined): boolean {
  return messageId?.startsWith("hotlap-limit-resume:") === true;
}

function isHiddenUsageLimitContinuation(item: TimelineTurnItem, isRetryRun: boolean): boolean {
  return (
    (item.type === "user_message" && isHotlapUsageLimitContinuationMessageId(item.messageId)) ||
    (item.type === "error" && item.failure?.class === "usage_limit" && isRetryRun)
  );
}

export function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }

  // Paired stop-then-steer results have a matching request on the same run and
  // must stay visible. Legacy plain-steer results have no request and stay hidden.
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  const run = input.runs.find((candidate) => candidate.id === item.runId);
  if (
    isHiddenUsageLimitContinuation(
      item,
      isHotlapUsageLimitContinuationMessageId(run?.userMessageId),
    )
  )
    return false;
  if (run?.status === "rolled_back") return false;
  // Cancelled queued input never reached the provider.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    run?.status === "cancelled"
  )
    return false;

  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}

/** Index once when reconciling a whole timeline after run/attempt state changes. */
export function createOrchestrationV2TurnItemVisibility(input: {
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): (item: TimelineTurnItem) => boolean {
  const statuses = new Map<TimelineRun["id"], TimelineRun["status"]>();
  const retryRuns = new Set<TimelineRun["id"]>();
  for (const run of input.runs) {
    const runId = run.id;
    statuses.set(runId, run.status);
    if (isHotlapUsageLimitContinuationMessageId(run.userMessageId)) retryRuns.add(runId);
  }
  const supersededRoots = new Map<
    TimelineRunAttempt["runId"],
    Set<TimelineRunAttempt["rootNodeId"]>
  >();
  for (const attempt of input.attempts) {
    if (attempt.status !== "superseded") continue;
    let roots = supersededRoots.get(attempt.runId);
    if (roots === undefined) supersededRoots.set(attempt.runId, (roots = new Set()));
    roots.add(attempt.rootNodeId);
  }
  const interruptRuns = new Set(
    input.items.filter((item) => item.type === "run_interrupt_request").map((item) => item.runId),
  );
  return (item) => {
    if (isHiddenUsageLimitContinuation(item, item.runId !== null && retryRuns.has(item.runId)))
      return false;
    const status = item.runId === null ? undefined : statuses.get(item.runId);
    if (status === "rolled_back") return false;
    if (
      status === "cancelled" &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    return !(
      item.type === "run_interrupt_result" &&
      item.runId !== null &&
      item.nodeId !== null &&
      supersededRoots.get(item.runId)?.has(item.nodeId) === true &&
      !interruptRuns.has(item.runId)
    );
  };
}
