import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, NetworkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { Thread } from "~/types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  deriveMasterBoard,
  isCardThreadTitle,
  isMasterThreadTitle,
} from "./MasterStatusBoard.logic";
import { useMasterLineageThreads } from "./useMasterLineageThreads";
import { useMasterStatusBoardEnabled } from "./useMasterSettings";

const STATUS_LABEL: Record<SidebarThreadStatus, string> = {
  approval: "Approval",
  input: "Needs input",
  working: "Working",
  monitoring: "Monitoring",
  failed: "Failed",
  ready: "Ready",
};

const STATUS_DOT: Record<SidebarThreadStatus, string> = {
  approval: "bg-amber-500",
  input: "bg-violet-500",
  working: "bg-sky-500",
  monitoring: "bg-sky-400",
  failed: "bg-destructive",
  ready: "bg-emerald-500",
};

function cardStatus(
  thread: EnvironmentThreadShell,
  now: string,
): {
  readonly label: string;
  readonly dot: string;
  readonly needsYou: boolean;
} {
  // Same precedence as the sidebar shelves: snooze outranks settlement, and a
  // parked Card never counts as needing you, whatever its runtime status.
  if (effectiveSnoozed(thread, { now })) {
    return { label: "Snoozed", dot: "bg-muted-foreground/60", needsYou: false };
  }
  if (thread.settledOverride === "settled") {
    return { label: "Completed", dot: "bg-muted-foreground", needsYou: false };
  }
  const status = resolveSidebarThreadStatus(thread);
  return {
    label: STATUS_LABEL[status],
    dot: STATUS_DOT[status],
    needsYou: status === "approval" || status === "input" || status === "failed",
  };
}

function shortTitle(title: string): string {
  return title.replace(/^(master|card)\s*:\s*/i, "");
}

function CardRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly now: string;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const status = cardStatus(props.thread, props.now);
  return (
    <Button
      variant="ghost"
      className="h-7 min-h-11 w-full justify-start gap-2 rounded-md px-2 text-xs font-normal"
      onClick={() => props.onOpen(props.thread)}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
      <span className="min-w-0 flex-1 truncate text-left">{shortTitle(props.thread.title)}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{status.label}</span>
    </Button>
  );
}

/**
 * Mount point for ChatView. Reads its own setting, and only mounts the board
 * (and its archived-lineage fetch) for Master and Card threads.
 */
export function MasterStatusBoardSlot(props: { readonly activeThread: Thread }) {
  const enabled = useMasterStatusBoardEnabled();
  const { title } = props.activeThread;
  if (!enabled || (!isMasterThreadTitle(title) && !isCardThreadTitle(title))) return null;
  return <MasterStatusBoard activeThread={props.activeThread} />;
}

function MasterStatusBoard(props: { readonly activeThread: Thread }) {
  const environmentIds = useMemo(
    () => [props.activeThread.environmentId],
    [props.activeThread.environmentId],
  );
  const threads = useMasterLineageThreads(environmentIds);
  const now = useNowMinute();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const board = useMemo(() => {
    const activeThreadShell = threads.find(
      (thread) =>
        thread.environmentId === props.activeThread.environmentId &&
        thread.id === props.activeThread.id,
    );
    return activeThreadShell ? deriveMasterBoard(activeThreadShell, threads) : null;
  }, [props.activeThread.environmentId, props.activeThread.id, threads]);

  if (board === null) return null;

  const attentionCount = board.cards.filter((thread) => cardStatus(thread, now).needsYou).length;
  const openThread = (thread: EnvironmentThreadShell) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-3 mt-2 shrink-0 rounded-lg border border-border/70 bg-muted/25"
      data-master-status-board=""
    >
      <CollapsibleTrigger className="flex h-9 min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-xs">
        <NetworkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 whitespace-nowrap font-medium">Master board</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {board.cards.length} {board.cards.length === 1 ? "card" : "cards"}
          {attentionCount > 0 ? ` · ${attentionCount} need you` : ""}
        </span>
        <ChevronDownIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel className="border-t border-border/60 px-1.5 py-1.5">
        {board.cards.length > 0 ? (
          <div className="flex flex-col gap-px">
            {board.cards.map((thread) => (
              <CardRow key={thread.id} thread={thread} now={now} onOpen={openThread} />
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">No cards linked to this Master.</p>
        )}
        {board.peerMasters.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-border/50 px-1 pt-1.5">
            <span className="px-1 text-[11px] text-muted-foreground">Other Masters</span>
            {board.peerMasters.map((thread) => (
              <Button
                key={thread.id}
                variant="ghost"
                size="xs"
                className="h-6 min-h-11 min-w-11 max-w-40 px-2 text-[11px]"
                onClick={() => openThread(thread)}
              >
                <span className="min-w-0 truncate">{shortTitle(thread.title)}</span>
              </Button>
            ))}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}
