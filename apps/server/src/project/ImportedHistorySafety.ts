import {
  isImportedAgentSessionMessageId,
  type AgentSessionImportSource,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProviderSessionRuntime } from "../persistence/ProviderSessionRuntime.ts";

const decodeCursor = Schema.decodeUnknownOption(
  Schema.Struct({ threadId: Schema.String, resume: Schema.optional(Schema.String) }),
);
export const MAX_IMPORTED_THREAD_AUDIT_EVENTS = 1_000;

export function importedBindingMatches(
  runtime: ProviderSessionRuntime,
  source: AgentSessionImportSource,
  threadId: ThreadId,
): boolean {
  if (
    runtime.threadId !== threadId ||
    runtime.providerName !== source.provider ||
    runtime.providerInstanceId !== source.providerInstanceId ||
    runtime.status !== "stopped"
  )
    return false;
  const cursor = decodeCursor(runtime.resumeCursor);
  if (Option.isNone(cursor)) return false;
  return source.provider === "codex"
    ? cursor.value.threadId === source.providerSessionId
    : cursor.value.threadId === threadId && cursor.value.resume === source.providerSessionId;
}

export function canReconcileImportedHistory(projection: OrchestrationV2ThreadProjection): boolean {
  const thread = projection.thread;
  return (
    thread.historyOrigin === "v1_import" &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride === "settled" &&
    thread.snoozedUntil == null &&
    thread.snoozedAt == null &&
    thread.pinnedAt == null &&
    thread.pinOrderKey == null &&
    thread.autoSettleDisabledAt == null &&
    thread.titleRegeneration == null &&
    thread.linkedPullRequest == null &&
    thread.unsettledAt == null &&
    projection.messages.length > 0 &&
    projection.messages.every(
      (message) =>
        isImportedAgentSessionMessageId(message.id) && message.runId === null && !message.streaming,
    ) &&
    projection.runs.length === 0 &&
    projection.attempts.length === 0 &&
    projection.nodes.length === 0 &&
    projection.providerSessions.length === 0 &&
    projection.providerTurns.length === 0 &&
    projection.runtimeRequests.length === 0 &&
    projection.plans.length === 0 &&
    projection.checkpoints.length === 0 &&
    projection.contextTransfers.length === 0 &&
    projection.contextHandoffs.length === 0 &&
    projection.providerThreads.every(
      (providerThread) =>
        (providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
        (providerThread.status === "idle" || providerThread.status === "not_loaded"),
    )
  );
}

/** IDs are server-generated provenance; any user command makes the old import immutable. */
export function isImportedHistoryEvent(stored: OrchestrationV2StoredEvent): boolean {
  const event = stored.event;
  if (stored.commandId !== null) return false;
  if (!event.id.startsWith("agent-session-import:v2:") && !event.id.startsWith("migration:v1:"))
    return false;
  return (
    event.type === "thread.created" ||
    event.type === "thread.metadata-updated" ||
    event.type === "message.updated" ||
    event.type === "turn-item.updated" ||
    event.type === "provider-thread.updated" ||
    event.type === "thread.imported-history-reconciled"
  );
}
