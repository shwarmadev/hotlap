import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, EllipsisIcon, PinIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { isCommandPaletteOpen, openCommandPalette } from "~/commandPaletteBus";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "~/keybindings";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useTerminalFocus } from "~/hooks/useTerminalFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import { useProjects, useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { useThreadActions } from "~/hooks/useThreadActions";
import { startNewThreadFromContext } from "~/lib/chatThreadActions";
import { resolveRenameCommit } from "../chat/ChatHeader";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import {
  resolveAdjacentThreadId,
  sortPinnedThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadWorktreeIndicator,
} from "../ThreadStatusIndicators";
import {
  deriveMasterWorkspace,
  isMasterThreadTitle,
  navigableRows,
  nextUnparkedKey,
  type MasterShelf,
  type MasterWorkspaceProject,
} from "./MasterStatusBoard.logic";
import { useMasterLineageThreads } from "./useMasterLineageThreads";
import { useMasterWorkspaceEnabled } from "./useMasterSettings";

type ThreadRow = EnvironmentThreadShell;
type ProjectGroup = MasterWorkspaceProject<ThreadRow>;

function rowKey(thread: ThreadRow): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function shortTitle(title: string) {
  return title.replace(/^(master|card)\s*:\s*/i, "");
}

function matchesSearch(title: string, query: string) {
  return title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function projectWorkSummary(group: ProjectGroup) {
  if (group.masters.length) return `${group.masters.length} Masters`;
  if (group.oneOffs.length) return `${group.oneOffs.length} Chats`;
  if (group.orphanCards.length) return `${group.orphanCards.length} Orphan Cards`;
  return "No threads";
}

/**
 * Mount point for AppSidebarLayout. Reads its own setting and falls back to
 * whichever upstream sidebar would otherwise render.
 */
export function MasterWorkspaceSidebarSlot(props: { readonly fallback: ReactNode }) {
  return useMasterWorkspaceEnabled() ? <MasterWorkspaceSidebar /> : props.fallback;
}

interface RowContext {
  readonly activeKey: string | null;
  readonly selectedKey?: string | null;
  readonly jumpLabelByKey: ReadonlyMap<string, string>;
  readonly renaming: { readonly key: string; readonly title: string } | null;
  readonly now: string;
  readonly isMobile: boolean;
  readonly onOpen: (thread: ThreadRow) => void;
  readonly onMenu: (thread: ThreadRow, position: { x: number; y: number }) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameCommit: (thread: ThreadRow, title: string) => void;
  readonly onRenameCancel: () => void;
}

function ThreadRowButton({
  thread,
  context,
  nested,
  pinned,
  trailing,
}: {
  thread: ThreadRow;
  context: RowContext;
  nested?: boolean;
  pinned?: boolean;
  trailing?: ReactNode;
}) {
  const key = rowKey(thread);
  const active = context.activeKey === key;
  const selected = context.selectedKey === key;
  const snoozedUntil =
    thread.snoozedUntil != null && effectiveSnoozed(thread, { now: context.now })
      ? thread.snoozedUntil
      : null;
  const jumpLabel = context.jumpLabelByKey.get(key) ?? null;
  const renamingTitle = context.renaming?.key === key ? context.renaming.title : null;
  const committedRef = useRef(false);

  if (renamingTitle !== null) {
    return (
      <div className={cn("flex min-h-11 items-center px-2", nested && "pl-4")}>
        <input
          autoFocus
          aria-label="Thread title"
          className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={renamingTitle}
          onFocus={(event) => {
            committedRef.current = false;
            event.currentTarget.select();
          }}
          onChange={(event) => context.onRenameChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              committedRef.current = true;
              context.onRenameCommit(thread, event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              committedRef.current = true;
              context.onRenameCancel();
            }
          }}
          onBlur={(event) => {
            if (!committedRef.current) context.onRenameCommit(thread, event.currentTarget.value);
          }}
        />
      </div>
    );
  }

  const openMenuAtElement = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    context.onMenu(thread, { x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <div className="group/master-row relative flex min-w-0 flex-1 items-center">
      <Button
        variant="ghost"
        className={cn(
          // Button's base classes include shrink-0; this row must yield space
          // to the actions and pin buttons beside it.
          "min-h-11 min-w-0 flex-1 shrink justify-start gap-2 px-2 text-xs font-normal",
          nested && "pl-4 text-muted-foreground",
          snoozedUntil && "text-muted-foreground",
          (active || selected) && "bg-sidebar-row-active text-sidebar-foreground",
        )}
        aria-current={active ? "page" : undefined}
        onClick={() => context.onOpen(thread)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          context.onMenu(thread, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openMenuAtElement(event.currentTarget);
          }
        }}
      >
        {pinned ? <PinIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
        <ThreadRowLeadingStatus thread={thread} />
        <span className="min-w-0 flex-1 truncate text-left">{shortTitle(thread.title)}</span>
        {snoozedUntil ? (
          <span className="shrink-0 text-[10px]">
            {snoozeWakeLabel(snoozedUntil, { now: context.now })}
          </span>
        ) : null}
        <ThreadWorktreeIndicator thread={thread} />
        <ThreadRowTrailingStatus thread={thread} />
      </Button>
      {jumpLabel ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
        >
          {jumpLabel}
        </span>
      ) : null}
      <Button
        variant="ghost"
        className={cn(
          "min-h-11 min-w-8 shrink-0 px-0 text-muted-foreground",
          // Hover-revealed on desktop; always reachable on touch.
          !context.isMobile &&
            "opacity-0 focus-visible:opacity-100 group-hover/master-row:opacity-100",
          context.isMobile && "min-w-11",
        )}
        aria-label={`Thread actions for ${shortTitle(thread.title)}`}
        onClick={(event: MouseEvent<HTMLButtonElement>) => openMenuAtElement(event.currentTarget)}
      >
        <EllipsisIcon className="size-3.5" />
      </Button>
      {trailing}
    </div>
  );
}

/**
 * A Master that only heads its Cards on this shelf: it is archived, or its own
 * row lives on another shelf. Inert, so each thread stays navigable once.
 */
function MasterHeading({ thread }: { thread: ThreadRow }) {
  return (
    <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{shortTitle(thread.title)}</span>
      {thread.archivedAt != null ? <span className="shrink-0 text-[10px]">Archived</span> : null}
    </div>
  );
}

function ProjectGroupRows({
  group,
  context,
  pinControl,
}: {
  group: ProjectGroup;
  context: RowContext;
  pinControl: (thread: ThreadRow) => ReactNode;
}) {
  if (group.masters.length === 0 && group.oneOffs.length === 0 && group.orphanCards.length === 0) {
    return (
      <p className="px-2 py-2 text-[11px] text-muted-foreground">
        No threads yet. Start one with New thread.
      </p>
    );
  }
  return (
    <>
      {group.masters.map((board) => (
        <div key={rowKey(board.master)} className="mb-1">
          {board.structural ? (
            <MasterHeading thread={board.master} />
          ) : (
            <ThreadRowButton
              thread={board.master}
              context={context}
              trailing={pinControl(board.master)}
            />
          )}
          {board.cards.map((card) => (
            <ThreadRowButton key={rowKey(card)} thread={card} context={context} nested />
          ))}
        </div>
      ))}
      {group.oneOffs.length ? (
        <div className="mt-1 border-t border-sidebar-border pt-1">
          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">Chats</p>
          {group.oneOffs.map((thread) => (
            <ThreadRowButton key={rowKey(thread)} thread={thread} context={context} />
          ))}
        </div>
      ) : null}
      {group.orphanCards.length ? (
        <div className="mt-1 border-t border-sidebar-border pt-1">
          <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">Orphan Cards</p>
          {group.orphanCards.map((thread) => (
            <ThreadRowButton key={rowKey(thread)} thread={thread} context={context} nested />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ShelfGroup({
  label,
  groups,
  expanded,
  onExpandedChange,
  projectTitle,
  renderGroup,
}: {
  label: string;
  groups: readonly ProjectGroup[];
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  projectTitle: (group: ProjectGroup) => ReactNode;
  renderGroup: (group: ProjectGroup) => ReactNode;
}) {
  if (groups.length === 0) return null;
  const count = groups.reduce((total, group) => total + group.visibleCount, 0);
  return (
    <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-left text-xs hover:bg-sidebar-accent">
          <ChevronDownIcon
            className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate">
            {label} ({count})
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel className="pl-3">
          {groups.map((group) => (
            <div key={`${group.environmentId}:${group.projectId}`} className="py-1">
              {projectTitle(group)}
              {renderGroup(group)}
            </div>
          ))}
        </CollapsiblePanel>
      </Collapsible>
    </SidebarGroup>
  );
}

function MasterWorkspaceSidebar() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  // Logical project groups (worktrees fold into their repo), the same count the
  // chat.new shortcut uses to decide between the picker and a direct create.
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))] as EnvironmentId[],
    [projects],
  );
  const threads = useMasterLineageThreads(environmentIds);
  const serverConfigs = useServerConfigs();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const now = useNowMinute();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const activeRef = resolveThreadRouteRef(params);
  const activeKey = activeRef ? scopedThreadKey(activeRef) : null;
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
  const { pinThread, confirmAndUnpinThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [openProjectKeys, setOpenProjectKeys] = useState<ReadonlySet<string>>(new Set());
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [settledExpanded, setSettledExpanded] = useState(false);
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null);

  const capability = useCallback(
    (environmentId: EnvironmentId, name: "threadSnooze" | "threadSettlement" | "threadPinning") =>
      serverConfigs.get(environmentId)?.environment.capabilities[name] === true,
    [serverConfigs],
  );
  // Same precedence as the default sidebar: snooze, then settlement, then pin.
  const shelfOf = useCallback(
    (thread: ThreadRow): MasterShelf => {
      if (capability(thread.environmentId, "threadSnooze") && effectiveSnoozed(thread, { now })) {
        return "snoozed";
      }
      if (
        capability(thread.environmentId, "threadSettlement") &&
        thread.settledOverride === "settled"
      ) {
        return "settled";
      }
      return thread.pinnedAt != null ? "pinned" : "active";
    },
    [capability, now],
  );
  const liveThreads = useMemo(
    () => threads.filter((thread) => thread.archivedAt == null),
    [threads],
  );
  const workspace = useMemo(
    () =>
      deriveMasterWorkspace({
        threads,
        projects: projects.map((project) => ({
          environmentId: project.environmentId,
          id: project.id,
        })),
        shelfOf,
      }),
    [projects, shelfOf, threads],
  );
  // Pinned order follows the shared pin sort, same as the default sidebar.
  const pinnedEntries = useMemo(() => {
    const entryByKey = new Map(workspace.pinned.map((entry) => [rowKey(entry.thread), entry]));
    return sortPinnedThreadsForSidebar(workspace.pinned.map((entry) => entry.thread)).flatMap(
      (thread) => entryByKey.get(rowKey(thread)) ?? [],
    );
  }, [workspace.pinned]);
  const searchResults = useMemo(
    () =>
      searchQuery.trim()
        ? liveThreads.filter((thread) => matchesSearch(thread.title, searchQuery))
        : [],
    [searchQuery, liveThreads],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectOf = useCallback(
    (group: { environmentId: string; projectId: string }) =>
      projectByKey.get(`${group.environmentId}:${group.projectId}`),
    [projectByKey],
  );
  const isProjectOpen = useCallback(
    (group: ProjectGroup) =>
      openProjectKeys.has(`${group.environmentId}:${group.projectId}`) ||
      (activeKey !== null && navigableRows(group).some((thread) => rowKey(thread) === activeKey)),
    [activeKey, openProjectKeys],
  );

  // Rows in on-screen order, for mod+1..9 and next/previous thread.
  const orderedRows = useMemo(() => {
    if (searchQuery.trim()) return searchResults;
    const rows: ThreadRow[] = pinnedEntries.flatMap((entry) => [entry.thread, ...entry.cards]);
    for (const group of workspace.activeProjects) {
      if (projectOf(group) && isProjectOpen(group)) rows.push(...navigableRows(group));
    }
    // Only rows that actually render: shelf groups without a project record don't.
    const shelfRows = (groups: readonly ProjectGroup[]) =>
      groups.filter((group) => projectOf(group)).flatMap(navigableRows);
    if (snoozedExpanded) rows.push(...shelfRows(workspace.snoozedProjects));
    if (settledExpanded) rows.push(...shelfRows(workspace.settledProjects));
    return rows;
  }, [
    isProjectOpen,
    pinnedEntries,
    projectOf,
    searchQuery,
    searchResults,
    settledExpanded,
    snoozedExpanded,
    workspace,
  ]);
  // Shelves are exclusive, so every row key is unique.
  const orderedKeys = useMemo(() => orderedRows.map(rowKey), [orderedRows]);
  const rowByKey = useMemo(
    () => new Map(orderedRows.map((thread) => [rowKey(thread), thread])),
    [orderedRows],
  );

  // Clamped at read time so a shrinking result list never points past its end.
  const selectedSearchIndex = Math.min(activeSearchIndex, Math.max(searchResults.length - 1, 0));
  const changeSearchQuery = (query: string) => {
    setSearchQuery(query);
    setActiveSearchIndex(0);
  };

  const openThread = useCallback(
    (thread: ThreadRow) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  const routePreviewOpen = useRightPanelStore((state) =>
    activeRef ? selectActiveRightPanel(state.byThreadKey, activeRef) === "preview" : false,
  );
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    activeRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, activeRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToKey = (key: string | null) => {
        const thread = key ? rowByKey.get(key) : undefined;
        if (!thread) return;
        event.preventDefault();
        event.stopPropagation();
        openThread(thread);
      };
      const direction = threadTraversalDirectionFromCommand(command);
      if (direction !== null) {
        navigateToKey(
          resolveAdjacentThreadId({
            threadIds: orderedKeys,
            currentThreadId: activeKey,
            direction,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) navigateToKey(orderedKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [activeKey, keybindings, openThread, orderedKeys, rowByKey, routeTerminalOpen]);

  // chat.new opens the "New thread in" picker whenever there is a real choice,
  // like the default sidebar, even if the legacy sidebar preference is saved
  // underneath this one. Capture phase runs before the route's global handler,
  // which skips events already handled here.
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen() || projectGroupCount <= 1) return;
      // Same context as the route's handler, so both resolve the same command.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen: routePreviewOpen,
        },
      });
      if (command !== "chat.new") return;
      event.preventDefault();
      event.stopPropagation();
      openCommandPalette({ open: "new-thread-in" });
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [keybindings, projectGroupCount, routePreviewOpen, routeTerminalOpen]);

  // Hints show only while the held modifiers exactly match a jump binding.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);
  const jumpLabelByKey = useMemo(() => {
    const labels = new Map<string, string>();
    if (!showThreadJumpHints) return labels;
    for (const [index, key] of orderedKeys.entries()) {
      const command = threadJumpCommandForIndex(index);
      if (!command) break;
      const label = shortcutLabelForCommand(keybindings, command);
      if (label) labels.set(key, label);
    }
    return labels;
  }, [keybindings, orderedKeys, showThreadJumpHints]);

  // One shared action menu (the chat header's) for every row.
  const menuTargetRef = useRef<ThreadRow | null>(null);
  const startRename = useCallback(() => {
    const thread = menuTargetRef.current;
    if (thread) setRenaming({ key: rowKey(thread), title: thread.title });
  }, []);
  const { openMenu } = useThreadActionMenu({
    threadRef: null,
    projectCwd: null,
    onStartRename: startRename,
  });
  // Synced in the commit that changes the route (layout effects run
  // synchronously there), so a park completing after a navigation always sees
  // the new route and never redirects the user.
  const activeKeyRef = useRef(activeKey);
  useLayoutEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);
  const onMenu = useCallback(
    (thread: ThreadRow, position: { x: number; y: number }) => {
      menuTargetRef.current = thread;
      const key = rowKey(thread);
      // Like the default sidebar: settling or snoozing the open thread from its
      // row moves on to the next unparked row (planned now, in today's order),
      // or to a new thread in its project.
      const nextKey = nextUnparkedKey(orderedKeys, key, (candidate) => {
        const row = rowByKey.get(candidate);
        return row === undefined || shelfOf(row) === "snoozed" || shelfOf(row) === "settled";
      });
      const next = nextKey ? rowByKey.get(nextKey) : undefined;
      openMenu(position, {
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        projectCwd: projectOf(thread)?.workspaceRoot ?? null,
        onParked: () => {
          // A navigation made while the command ran wins over ours.
          if (activeKeyRef.current !== key) return;
          if (next) openThread(next);
          else
            void newThreadContext.handleNewThread(
              scopeProjectRef(thread.environmentId, thread.projectId),
            );
        },
      });
    },
    [newThreadContext, openMenu, openThread, orderedKeys, projectOf, rowByKey, shelfOf],
  );
  const commitRename = useCallback(
    (thread: ThreadRow, title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [updateThreadMetadata],
  );

  const togglePin = useCallback(
    (thread: ThreadRow) => {
      const ref: ScopedThreadRef = scopeThreadRef(thread.environmentId, thread.id);
      void (thread.pinnedAt != null ? confirmAndUnpinThread(ref) : pinThread(ref)).then(
        (result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: thread.pinnedAt != null ? "Failed to unpin thread" : "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
        },
      );
    },
    [confirmAndUnpinThread, pinThread],
  );
  const pinControl = (thread: ThreadRow) => {
    if (thread.archivedAt != null || !capability(thread.environmentId, "threadPinning")) {
      return null;
    }
    const pinned = thread.pinnedAt != null;
    return (
      <Button
        variant="ghost"
        className="min-h-11 min-w-11 shrink-0"
        aria-label={pinned ? "Unpin Master" : "Pin Master"}
        aria-pressed={pinned}
        onClick={() => togglePin(thread)}
      >
        <PinIcon className={cn("size-3", pinned && "fill-current")} />
      </Button>
    );
  };

  const rowContext: RowContext = {
    activeKey,
    jumpLabelByKey,
    renaming,
    now,
    isMobile,
    onOpen: openThread,
    onMenu,
    onRenameChange: (title) => setRenaming((current) => (current ? { ...current, title } : null)),
    onRenameCommit: commitRename,
    onRenameCancel: () => setRenaming(null),
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((selectedSearchIndex + 1) % searchResults.length);
    } else if (event.key === "ArrowUp" && searchResults.length) {
      event.preventDefault();
      setActiveSearchIndex((selectedSearchIndex - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === "Enter" && searchResults[selectedSearchIndex]) {
      event.preventDefault();
      openThread(searchResults[selectedSearchIndex]);
    } else if (event.key === "Escape") changeSearchQuery("");
  };
  const onNewThread = (event?: MouseEvent) => {
    if (isMobile) setOpenMobile(false);
    if (projectGroupCount > 1 && !event?.shiftKey) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
  };
  // Mirrors the default sidebar: with several projects the primary label is
  // only the picker's shortcut, and chat.newLocal is the direct-create twin.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroupCount <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");

  const shelfProjectTitle = (group: ProjectGroup) => {
    const project = projectOf(group);
    return project ? (
      <div className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
        <ProjectFavicon project={project} className="size-3.5" />
        {project.title}
      </div>
    ) : null;
  };
  const renderShelfGroup = (group: ProjectGroup) =>
    projectOf(group) ? (
      <ProjectGroupRows group={group} context={rowContext} pinControl={pinControl} />
    ) : null;

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="p-[var(--sidebar-content-inset)] pt-1">
            <SidebarThreadHeader
              hasProjects={projects.length > 0}
              projectScope={null}
              onNewProject={() => openCommandPalette({ open: "add-project" })}
              onNewThread={onNewThread}
              newThreadDisabled={false}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={projectGroupCount > 1}
              searchInputRef={searchInputRef}
              searchQuery={searchQuery}
              onSearchQueryChange={changeSearchQuery}
              onSearchKeyDown={onSearchKeyDown}
              isSearching={Boolean(searchQuery.trim())}
              searchResultCount={searchResults.length}
              activeSearchResultIndex={selectedSearchIndex}
              onClearSearch={() => changeSearchQuery("")}
            />
          </SidebarGroup>
        }
      >
        {searchQuery.trim() ? (
          <SidebarGroup
            className="px-[var(--sidebar-content-inset)] py-2"
            id="sidebar-thread-search-results"
            role="listbox"
          >
            {searchResults.map((thread, index) => (
              <ThreadRowButton
                key={rowKey(thread)}
                thread={thread}
                context={{
                  ...rowContext,
                  activeKey: null,
                  selectedKey: index === selectedSearchIndex ? rowKey(thread) : null,
                }}
              />
            ))}
          </SidebarGroup>
        ) : (
          <>
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <p className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium text-muted-foreground">
                Pinned
              </p>
              {pinnedEntries.length === 0 ? (
                <p className="px-[var(--sidebar-row-content-inset)] py-2 text-xs text-muted-foreground">
                  Pin a Master to keep it here.
                </p>
              ) : (
                pinnedEntries.map(({ thread, cards }) => (
                  <div key={rowKey(thread)}>
                    <ThreadRowButton
                      thread={thread}
                      context={rowContext}
                      pinned
                      trailing={isMasterThreadTitle(thread.title) ? pinControl(thread) : null}
                    />
                    {cards.map((card) => (
                      <ThreadRowButton
                        key={rowKey(card)}
                        thread={card}
                        context={rowContext}
                        nested
                      />
                    ))}
                  </div>
                ))
              )}
            </SidebarGroup>
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <p className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium text-muted-foreground">
                Projects
              </p>
              {workspace.activeProjects.map((group) => {
                const projectKey = `${group.environmentId}:${group.projectId}`;
                const project = projectOf(group);
                if (!project) return null;
                const open = isProjectOpen(group);
                return (
                  <Collapsible
                    key={projectKey}
                    open={open}
                    onOpenChange={(next) =>
                      setOpenProjectKeys((current) => {
                        const updated = new Set(current);
                        if (next) updated.add(projectKey);
                        else updated.delete(projectKey);
                        return updated;
                      })
                    }
                  >
                    <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-[var(--sidebar-row-content-inset)] text-left text-xs hover:bg-sidebar-accent">
                      <ChevronDownIcon
                        className={cn(
                          "size-3 shrink-0 transition-transform",
                          !open && "-rotate-90",
                        )}
                      />
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {projectWorkSummary(group)}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel className="pl-3">
                      <ProjectGroupRows
                        group={group}
                        context={rowContext}
                        pinControl={pinControl}
                      />
                    </CollapsiblePanel>
                  </Collapsible>
                );
              })}
            </SidebarGroup>
            <ShelfGroup
              label="Snoozed"
              groups={workspace.snoozedProjects}
              expanded={snoozedExpanded}
              onExpandedChange={setSnoozedExpanded}
              projectTitle={shelfProjectTitle}
              renderGroup={renderShelfGroup}
            />
            <ShelfGroup
              label="Settled"
              groups={workspace.settledProjects}
              expanded={settledExpanded}
              onExpandedChange={setSettledExpanded}
              projectTitle={shelfProjectTitle}
              renderGroup={renderShelfGroup}
            />
          </>
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
