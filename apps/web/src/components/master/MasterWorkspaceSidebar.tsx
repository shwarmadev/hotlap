import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed, snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import {
  Fragment,
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
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { startNewThreadFromContext } from "~/lib/chatThreadActions";
import { resolveRenameCommit } from "../chat/ChatHeader";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarThreadHeader } from "../sidebar/SidebarThreadHeader";
import { EMPTY_PROVIDER_ENTRIES, SidebarSectionHeader, SidebarThreadRow } from "../Sidebar";
import {
  resolveAdjacentThreadId,
  sortPinnedThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  deriveMasterWorkspace,
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

function projectKeyOf(thread: { environmentId: string; projectId: string }): string {
  return `${thread.environmentId}:${thread.projectId}`;
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
  // Inside a project group, whose header already names the project: rows of
  // that project drop their project icon, rows of another project keep it.
  readonly groupTitle?: string;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly timestampFormat: TimestampFormat;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly environmentMachineById: ReadonlyMap<string, EnvironmentMachineKind>;
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, ProviderInstanceEntry>
  >;
  readonly onOpen: (thread: ThreadRow) => void;
  readonly onMenu: (thread: ThreadRow, position: { x: number; y: number }) => void;
  readonly onRenameStart: (thread: ThreadRow) => void;
  readonly onRenameChange: (title: string) => void;
  readonly onRenameCommit: (thread: ThreadRow, title: string) => void;
  readonly onRenameCancel: () => void;
}

// Settle, snooze, wake and unpin go through the row's action menu, where
// parking the open thread moves on to the next Master-workspace row, so the
// standard row's inline lifecycle buttons stay off.
const noLifecycleAction = () => {};

/** One thread, rendered by the standard sidebar's slim row. */
function MasterThreadRow({ thread, context }: { thread: ThreadRow; context: RowContext }) {
  const key = rowKey(thread);
  const projectKey = projectKeyOf(thread);
  const snoozedUntil =
    thread.snoozedUntil != null && effectiveSnoozed(thread, { now: context.now })
      ? thread.snoozedUntil
      : null;
  const renamingTitle = context.renaming?.key === key ? context.renaming.title : null;
  return (
    <SidebarThreadRow
      thread={thread}
      variant="slim"
      variantAction={
        snoozedUntil ? "unsnooze" : thread.settledOverride === "settled" ? "unsettle" : "settle"
      }
      settlementSupported={false}
      snoozeSupported={false}
      pinningSupported={false}
      isPinned={thread.pinnedAt != null}
      dropVerb={null}
      dragOverPinned={false}
      snoozeWakeLabelText={
        snoozedUntil ? snoozeWakeLabel(snoozedUntil, { now: context.now }) : null
      }
      wokeAt={null}
      isActive={context.activeKey === key || context.selectedKey === key}
      openPullRequestsInRightPanel={context.activeKey !== null}
      jumpLabel={context.jumpLabelByKey.get(key) ?? null}
      currentEnvironmentId={context.primaryEnvironmentId}
      environmentLabel={context.environmentLabelById.get(thread.environmentId) ?? null}
      environmentMachine={context.environmentMachineById.get(thread.environmentId) ?? "server"}
      project={context.projectByKey.get(projectKey) ?? null}
      projectDisplayName={context.projectTitleByKey.get(projectKey) ?? null}
      providerEntryByInstanceId={
        context.providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
      }
      timestampFormat={context.timestampFormat}
      onThreadClick={() => context.onOpen(thread)}
      onThreadActivate={() => context.onOpen(thread)}
      onStartRename={() => context.onRenameStart(thread)}
      onRenameTitleChange={context.onRenameChange}
      onCommitRename={(_ref: ScopedThreadRef, title: string) =>
        context.onRenameCommit(thread, title)
      }
      onCancelRename={context.onRenameCancel}
      isRenaming={renamingTitle !== null}
      renamingTitle={renamingTitle ?? ""}
      onContextMenu={(_ref: ScopedThreadRef, position: { x: number; y: number }) =>
        context.onMenu(thread, position)
      }
      onSettle={noLifecycleAction}
      onUnsettle={noLifecycleAction}
      onSnooze={noLifecycleAction}
      onUnsnooze={noLifecycleAction}
      onUnpin={noLifecycleAction}
      onAcknowledgeWoke={noLifecycleAction}
      hideProjectIcon={
        context.groupTitle !== undefined &&
        context.projectTitleByKey.get(projectKey) === context.groupTitle
      }
      showStatusIcon
      actionsButton={context.isMobile ? "always" : "on-hover"}
    />
  );
}

/**
 * A Master and its Cards, flat like the default sidebar: lineage order and
 * the "Master:" / "Card:" titles carry the hierarchy. A structural Master only heads its Cards on this
 * shelf: it is archived, or its own row lives on another shelf. It renders as
 * an inert heading, so each thread stays navigable once.
 */
function MasterBoard({
  master,
  cards,
  structural,
  context,
}: {
  master: ThreadRow;
  cards: readonly ThreadRow[];
  structural?: boolean;
  context: RowContext;
}) {
  return (
    <>
      {structural ? (
        <SidebarSectionHeader
          label={master.title}
          {...(master.archivedAt != null ? { detail: "Archived" } : {})}
        />
      ) : (
        <MasterThreadRow thread={master} context={context} />
      )}
      {cards.map((card) => (
        <MasterThreadRow key={rowKey(card)} thread={card} context={context} />
      ))}
    </>
  );
}

function ProjectGroupRows({
  group,
  title,
  context: outerContext,
}: {
  group: ProjectGroup;
  title: string;
  context: RowContext;
}) {
  const context = { ...outerContext, groupTitle: title };
  if (group.masters.length === 0 && group.oneOffs.length === 0 && group.orphanCards.length === 0) {
    return (
      <li className="list-none">
        <p className="px-2 py-2 text-[11px] text-muted-foreground">
          No threads yet. Start one with New thread.
        </p>
      </li>
    );
  }
  return (
    <>
      {group.masters.map((board) => (
        <MasterBoard
          key={rowKey(board.master)}
          master={board.master}
          cards={board.cards}
          structural={board.structural}
          context={context}
        />
      ))}
      {group.oneOffs.length ? (
        <>
          <SidebarSectionHeader label="Chats" />
          {group.oneOffs.map((thread) => (
            <MasterThreadRow key={rowKey(thread)} thread={thread} context={context} />
          ))}
        </>
      ) : null}
      {group.orphanCards.length ? (
        <>
          <SidebarSectionHeader label="Orphan Cards" />
          {group.orphanCards.map((thread) => (
            <MasterThreadRow key={rowKey(thread)} thread={thread} context={context} />
          ))}
        </>
      ) : null}
    </>
  );
}

function ShelfGroup({
  label,
  tone,
  groups,
  expanded,
  onExpandedChange,
  projectTitle,
  renderGroup,
}: {
  label: string;
  tone?: "snoozed";
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
      <ul role="list" className="flex flex-col gap-px">
        <SidebarSectionHeader
          label={`${label} (${count})`}
          {...(tone ? { tone } : {})}
          toggle={{ expanded, onToggle: () => onExpandedChange(!expanded) }}
        />
        {expanded
          ? groups.map((group) => (
              <Fragment key={`${group.environmentId}:${group.projectId}`}>
                {projectTitle(group)}
                {renderGroup(group)}
              </Fragment>
            ))
          : null}
      </ul>
    </SidebarGroup>
  );
}

function MasterWorkspaceSidebar() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  // Logical project groups carry the same representative title and icon as the
  // standard sidebar, so worktrees inherit their parent project's presentation.
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const projectGroupCount = projectGroups.length;
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))] as EnvironmentId[],
    [projects],
  );
  const threads = useMasterLineageThreads(environmentIds);
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // The same row inputs the default sidebar derives for its thread rows.
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const now = useNowMinute();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const activeRef = resolveThreadRouteRef(params);
  const activeKey = activeRef ? scopedThreadKey(activeRef) : null;
  const { isMobile, setOpenMobile } = useSidebar();
  const newThreadContext = useHandleNewThread();
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
    (environmentId: EnvironmentId, name: "threadSnooze" | "threadSettlement") =>
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
  const projectPresentationByKey = useMemo(() => {
    const presentations = new Map<
      string,
      { project: (typeof projectGroups)[number]; title: string }
    >();
    for (const group of projectGroups) {
      for (const project of group.memberProjects) {
        presentations.set(`${project.environmentId}:${project.id}`, {
          project: group,
          title: group.displayName,
        });
      }
    }
    return presentations;
  }, [projectGroups]);
  const projectTitleByKey = useMemo(
    () =>
      new Map(
        [...projectPresentationByKey].map(([key, presentation]) => [key, presentation.title]),
      ),
    [projectPresentationByKey],
  );
  const projectOf = useCallback(
    (group: { environmentId: string; projectId: string }) => {
      const key = `${group.environmentId}:${group.projectId}`;
      const presentation = projectPresentationByKey.get(key);
      if (presentation) return presentation;
      const project = projectByKey.get(key);
      return project ? { project, title: project.title } : null;
    },
    [projectByKey, projectPresentationByKey],
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
        projectCwd: projectOf(thread)?.project.workspaceRoot ?? null,
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

  const rowContext: RowContext = {
    activeKey,
    jumpLabelByKey,
    renaming,
    now,
    isMobile,
    primaryEnvironmentId,
    timestampFormat,
    projectByKey,
    projectTitleByKey,
    environmentLabelById,
    environmentMachineById,
    providerEntriesByEnvironment,
    onOpen: openThread,
    onMenu,
    onRenameStart: (thread) => setRenaming({ key: rowKey(thread), title: thread.title }),
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
    const presentation = projectOf(group);
    return presentation ? (
      <SidebarSectionHeader
        icon={<ProjectFavicon project={presentation.project} className="size-4 shrink-0" />}
        label={presentation.title}
      />
    ) : null;
  };
  const renderShelfGroup = (group: ProjectGroup) => {
    const presentation = projectOf(group);
    return presentation ? (
      <ProjectGroupRows group={group} title={presentation.title} context={rowContext} />
    ) : null;
  };

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
        <TooltipProvider delay={150} closeDelay={0} timeout={400}>
          {searchQuery.trim() ? (
            <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
              <ul
                id="sidebar-thread-search-results"
                role="listbox"
                aria-label="Thread search results"
                className="flex flex-col gap-px"
              >
                {searchResults.map((thread, index) => (
                  <MasterThreadRow
                    key={rowKey(thread)}
                    thread={thread}
                    context={{
                      ...rowContext,
                      activeKey: null,
                      selectedKey: index === selectedSearchIndex ? rowKey(thread) : null,
                    }}
                  />
                ))}
              </ul>
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
                <ul role="list" className="flex flex-col gap-px">
                  <SidebarSectionHeader label="Pinned" />
                  {pinnedEntries.length === 0 ? (
                    <li className="list-none">
                      <p className="px-[var(--sidebar-row-content-inset)] py-2 text-xs text-muted-foreground">
                        Pin a Master to keep it here.
                      </p>
                    </li>
                  ) : (
                    pinnedEntries.map(({ thread, cards }) => (
                      <MasterBoard
                        key={rowKey(thread)}
                        master={thread}
                        cards={cards}
                        context={rowContext}
                      />
                    ))
                  )}
                </ul>
              </SidebarGroup>
              <SidebarGroup className="px-[var(--sidebar-content-inset)] py-2">
                <ul role="list" className="flex flex-col gap-px">
                  <SidebarSectionHeader label="Projects" />
                  {workspace.activeProjects.map((group) => {
                    const projectKey = `${group.environmentId}:${group.projectId}`;
                    const presentation = projectOf(group);
                    if (!presentation) return null;
                    const open = isProjectOpen(group);
                    return (
                      <Fragment key={projectKey}>
                        <SidebarSectionHeader
                          icon={
                            <ProjectFavicon
                              project={presentation.project}
                              className="size-4 shrink-0"
                            />
                          }
                          label={presentation.title}
                          detail={projectWorkSummary(group)}
                          toggle={{
                            expanded: open,
                            onToggle: () =>
                              setOpenProjectKeys((current) => {
                                const updated = new Set(current);
                                if (open) updated.delete(projectKey);
                                else updated.add(projectKey);
                                return updated;
                              }),
                          }}
                        />
                        {open ? (
                          <ProjectGroupRows
                            group={group}
                            title={presentation.title}
                            context={rowContext}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                </ul>
              </SidebarGroup>
              <ShelfGroup
                label="Snoozed"
                tone="snoozed"
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
        </TooltipProvider>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
