import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  getComposerDraftSnapshot,
  clearComposerDraftContent,
} from "../../state/use-composer-drafts";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Option from "effect/Option";
import type { MenuAction } from "@react-native-menu/menu";
import {
  CommandId,
  MessageId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type MessageId,
  type ModelSelection,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  deriveForkableAssistantMessageIds,
  requestOlderThreadTurns,
  threadHasOlderTurns,
  waitForSynchronizedValue,
} from "@t3tools/client-runtime/state/threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentShellState } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { EmptyState } from "../../components/EmptyState";
import {
  AndroidHeaderIconButton,
  AndroidScreenHeader,
  type AndroidHeaderAction,
} from "../../components/AndroidScreenHeader";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";
import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import {
  copyThreadTranscript,
  environmentThreadDetails,
  threadEnvironment,
} from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { uuidv4 } from "../../lib/uuid";
import { ControlPillMenu } from "../../components/ControlPill";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";
import { threadRouteIsHydrating } from "./thread-route-hydration";
import { ForkConversationSheet } from "./ForkConversationSheet";
import {
  buildForkCommandInput,
  buildForkModelOptions,
  canConfirmForkModelSelection,
  forkModelPickerShouldClose,
  openForkModelPicker,
  type ForkModelPickerState,
} from "./fork-model-picker-state";

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title="Thread unavailable"
        detail="This thread is not available in the current mobile snapshot."
        actionLabel={props.actionLabel}
        onAction={props.onAction}
      />
    </ScrollView>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const { state: workspaceState } = useWorkspaceState();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeEnvironmentShellState = useEnvironmentShellState(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const navigation = useNavigation();
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, the floating pill above the
  // composer reports loading/syncing, and the composer's connection pill
  // reports connecting/reconnecting status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating = threadRouteIsHydrating({
    isLoadingConnections: workspaceState.isLoadingConnections,
    connectionState: routeConnectionState,
    shellStatus: routeEnvironmentShellState.status,
    shellHasError: Option.isSome(routeEnvironmentShellState.error),
    detailStatus: selectedThreadDetailState.status,
    detailHasError: Option.isSome(selectedThreadDetailState.error),
  });

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return (
    <ThreadUnavailableScreen
      actionLabel={
        routeEnvironmentRuntime === null ? "Manage environments" : "Reconnect environment"
      }
      onAction={() => {
        if (routeEnvironmentRuntime !== null) {
          onReconnectEnvironment(environmentId);
          return;
        }
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironments" },
        });
      }}
    />
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { themeVariables } = useAppearancePreferences();
  const headerColor = themeVariables["--color-header"];
  const {
    fileInspector,
    layout,
    panes,
    showAuxiliaryPane,
    toggleAuxiliaryPane,
    togglePrimarySidebar,
  } = useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const {
    selectedThread,
    selectedThreadCreation,
    selectedThreadProject,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const forkableAssistantMessageIds = useMemo(
    () =>
      deriveForkableAssistantMessageIds(
        selectedThreadDetail?.checkpoints ?? [],
        selectedThreadDetail?.latestTurn,
      ),
    [selectedThreadDetail?.checkpoints, selectedThreadDetail?.latestTurn],
  );
  // "Load earlier turns" header state for windowed (paginated) thread loads.
  const loadEarlierTurns = useMemo(() => {
    if (selectedThread === null || !threadHasOlderTurns(selectedThreadDetailState)) {
      return null;
    }
    return {
      loading:
        selectedThreadDetailState.page._tag === "Some" &&
        selectedThreadDetailState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(selectedThread.environmentId, selectedThread.id);
      },
    };
  }, [selectedThread, selectedThreadDetailState]);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const forkThread = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const loadThreadTranscript = useAtomCommand(copyThreadTranscript, { reportFailure: false });
  const forkWaitAbortRef = useRef<AbortController | null>(null);
  const [forkPending, setForkPending] = useState(false);
  const [forkModelPicker, setForkModelPicker] = useState<ForkModelPickerState | null>(null);
  const cancelPendingFork = useCallback(() => {
    forkWaitAbortRef.current?.abort();
    forkWaitAbortRef.current = null;
    setForkPending(false);
    setForkModelPicker(null);
  }, []);
  const navigation = useNavigation();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  const forkRouteIdentityRef = useRef(routeThreadIdentity);
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  const inspectorMode = (() => {
    if (inspectorSelection?.routeThreadIdentity === routeThreadIdentity) {
      if (inspectorSelection.mode === "files" && selectedThreadCwd === null) {
        return null;
      }
      return inspectorSelection.mode;
    }
    return null;
  })();
  useEffect(() => {
    if (
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  useEffect(() => {
    setInspectorSelection((current) => {
      if (props.renderInspector === undefined) {
        if (current === null || current.mode === "route") {
          return null;
        }
        return { ...current, routeThreadIdentity };
      }

      if (current === null || current.mode === "route") {
        return { routeThreadIdentity, mode: "route" };
      }

      return { ...current, routeThreadIdentity };
    });
  }, [props.renderInspector, routeThreadIdentity]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        cancelPendingFork();
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [cancelPendingFork, props.renderInspector]),
  );
  // Abort during the route commit. A passive effect leaves a window where the
  // old fork promise can settle and navigate from the newly selected thread.
  useLayoutEffect(() => {
    if (forkRouteIdentityRef.current === routeThreadIdentity) return;
    forkRouteIdentityRef.current = routeThreadIdentity;
    cancelPendingFork();
  }, [cancelPendingFork, routeThreadIdentity]);
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );
  const canForkConversation =
    routeEnvironmentRuntime?.serverConfig?.environment.capabilities.threadForking === true &&
    selectedThread !== null &&
    selectedThread.session?.status !== "running" &&
    selectedThread.session?.status !== "starting" &&
    !selectedThread.hasPendingApprovals &&
    !selectedThread.hasPendingUserInput &&
    selectedThread.backgroundLiveness == null;
  const forkServerConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const supportsForkModelSelection =
    forkServerConfig?.environment.capabilities.threadForkModelSelection === true;
  const forkModelOptions = useMemo(
    () =>
      forkModelPicker && forkServerConfig
        ? buildForkModelOptions(forkServerConfig, forkModelPicker.selectedModel)
        : [],
    [forkModelPicker, forkServerConfig],
  );
  const supportsTranscriptExport =
    routeEnvironmentRuntime?.serverConfig?.environment.capabilities.threadTranscriptExport ===
      true && selectedThread !== null;
  useLayoutEffect(() => {
    if (!forkModelPicker) return;
    if (
      !canForkConversation ||
      selectedThread === null ||
      forkModelPickerShouldClose(forkModelPicker, {
        connected: routeConnectionState === "connected",
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        sourceMessageAvailable: forkableAssistantMessageIds.has(forkModelPicker.source.messageId),
      })
    ) {
      // External connection/source state owns this dismissal; retaining local
      // picker state would let it resurface after a reconnect.
      // oxlint-disable-next-line react/set-state-in-effect
      cancelPendingFork();
    }
  }, [
    canForkConversation,
    cancelPendingFork,
    forkModelPicker,
    forkableAssistantMessageIds,
    routeConnectionState,
    selectedThread,
  ]);
  const executeFork = useCallback(
    async (picker: ForkModelPickerState, includeModelSelection: boolean) => {
      if (forkWaitAbortRef.current !== null) return;
      const destinationThreadId = ThreadId.make(uuidv4());
      const forkWaitAbort = new AbortController();
      forkWaitAbortRef.current = forkWaitAbort;
      setForkPending(true);
      if (includeModelSelection) {
        setForkModelPicker((current) =>
          current?.source.messageId === picker.source.messageId
            ? { ...current, status: "submitting", error: null }
            : current,
        );
      }
      const result = await forkThread({
        environmentId: picker.source.environmentId,
        input: includeModelSelection
          ? buildForkCommandInput(picker, destinationThreadId, new Date().toISOString())
          : {
              threadId: destinationThreadId,
              sourceThreadId: picker.source.threadId,
              sourceMessageId: picker.source.messageId,
              createdAt: new Date().toISOString(),
            },
      });
      if (forkWaitAbort.signal.aborted) return;
      if (result._tag === "Failure") {
        if (forkWaitAbortRef.current === forkWaitAbort) {
          forkWaitAbortRef.current = null;
          setForkPending(false);
        }
        const interrupted = isAtomCommandInterrupted(result);
        if (includeModelSelection) {
          const error = interrupted ? null : squashAtomCommandFailure(result);
          const message = interrupted
            ? "Forking was interrupted. Try again."
            : error instanceof Error
              ? error.message
              : "An error occurred.";
          setForkModelPicker((current) =>
            current?.source.messageId === picker.source.messageId
              ? { ...current, status: "idle", error: message }
              : current,
          );
        } else if (!interrupted) {
          const error = squashAtomCommandFailure(result);
          const message = error instanceof Error ? error.message : "An error occurred.";
          Alert.alert("Couldn’t fork conversation", message);
        }
        return;
      }
      const destinationThreadRef = scopeThreadRef(picker.source.environmentId, destinationThreadId);
      const destinationThreadAtom = environmentThreadDetails.stateAtom(destinationThreadRef);
      const forkSynced = await waitForSynchronizedValue({
        read: () => appAtomRegistry.get(destinationThreadAtom),
        subscribe: (listener) => appAtomRegistry.subscribe(destinationThreadAtom, listener),
        isReady: (state) => Option.isSome(state.data),
        isUnavailable: (state) => state.status === "deleted",
        signal: forkWaitAbort.signal,
      });
      if (forkWaitAbortRef.current === forkWaitAbort) {
        forkWaitAbortRef.current = null;
        setForkPending(false);
      }
      if (forkWaitAbort.signal.aborted) return;
      if (!forkSynced) {
        const message = "The destination was deleted before it could be opened.";
        if (includeModelSelection) {
          setForkModelPicker((current) =>
            current?.source.messageId === picker.source.messageId
              ? { ...current, status: "idle", error: message }
              : current,
          );
        } else {
          Alert.alert("Fork is no longer available", message);
        }
        return;
      }
      setForkModelPicker(null);
      navigation.navigate("Thread", {
        environmentId: String(picker.source.environmentId),
        threadId: String(destinationThreadId),
      });
    },
    [forkThread, navigation],
  );
  const handleForkAssistantMessage = useCallback(
    async (sourceMessageId: MessageId) => {
      if (
        !canForkConversation ||
        selectedThread === null ||
        forkWaitAbortRef.current !== null ||
        forkModelPicker !== null
      ) {
        return;
      }
      const picker = openForkModelPicker({
        environmentId: selectedThread.environmentId,
        sourceThreadId: selectedThread.id,
        sourceMessageId,
        modelSelection: selectedThread.modelSelection,
      });
      if (supportsForkModelSelection) {
        setForkModelPicker(picker);
        return;
      }
      await executeFork(picker, false);
    },
    [canForkConversation, executeFork, forkModelPicker, selectedThread, supportsForkModelSelection],
  );
  const handleForkModelSelect = useCallback((modelSelection: ModelSelection) => {
    setForkModelPicker((current) =>
      current
        ? {
            ...current,
            selectedModel: {
              instanceId: modelSelection.instanceId,
              model: modelSelection.model,
              ...(modelSelection.options
                ? { options: modelSelection.options.map((option) => ({ ...option })) }
                : {}),
            },
            error: null,
          }
        : null,
    );
  }, []);
  const handleForkModelConfirm = useCallback(async () => {
    if (!forkModelPicker || forkModelPicker.status === "submitting") return;
    if (
      !supportsForkModelSelection ||
      !canForkConversation ||
      selectedThread === null ||
      forkModelPickerShouldClose(forkModelPicker, {
        connected: routeConnectionState === "connected",
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        sourceMessageAvailable: forkableAssistantMessageIds.has(forkModelPicker.source.messageId),
      })
    ) {
      cancelPendingFork();
      return;
    }
    if (!canConfirmForkModelSelection(forkModelPicker.selectedModel, forkModelOptions)) {
      setForkModelPicker((current) =>
        current ? { ...current, error: "Choose an available provider and model." } : null,
      );
      return;
    }
    await executeFork(forkModelPicker, true);
  }, [
    canForkConversation,
    cancelPendingFork,
    executeFork,
    forkModelOptions,
    forkModelPicker,
    forkableAssistantMessageIds,
    routeConnectionState,
    selectedThread,
    supportsForkModelSelection,
  ]);
  const handleCopyTranscript = useCallback(async () => {
    if (!supportsTranscriptExport || selectedThread === null) return;
    const result = await loadThreadTranscript({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Couldn’t copy transcript",
          error instanceof Error ? error.message : "An error occurred.",
        );
      }
      return;
    }
    const copied = await tryCopyTextWithHaptic(result.value.markdown, {
      target: "thread transcript",
    });
    if (!copied) {
      Alert.alert("Couldn’t copy transcript", "The clipboard is unavailable.");
    }
  }, [loadThreadTranscript, selectedThread, supportsTranscriptExport]);

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = useCallback(() => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [fileInspector.supported, navigation, routeThreadIdentity, selectedThread, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    navigation,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      const params = {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      if (fileInspector.supported) {
        navigation.navigate("ThreadFile", params);
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [fileInspector.supported, navigation, selectedThread],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // panes bring their own nested native headers (which underlap the status
  // bar); elsewhere the pane content pads itself below the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const GitInspector = useCallback(
    () => (
      <GitOverviewSheet
        headerInset={inspectorHeaderInset}
        presentation="inspector"
        route={{ params: props.route.params }}
      />
    ),
    [inspectorHeaderInset, props.route.params],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={inspectorHeaderInset}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      inspectorHeaderInset,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const RouteInspector = useCallback(
    () => props.renderInspector?.(inspectorHeaderInset),
    [inspectorHeaderInset, props.renderInspector],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          Files={FilesInspector}
          Git={GitInspector}
          mode={inspectorMode}
          Route={props.renderInspector ? RouteInspector : undefined}
        />
      ),
    [FilesInspector, GitInspector, RouteInspector, inspectorMode, props.renderInspector],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;
  // Hand the inspector to the workspace so it renders beside the navigator,
  // outside this screen's native header — the terminal/git/files toolbar
  // stays anchored to the chat pane instead of floating above the inspector.
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = useCallback(() => {
    void navigation.navigate("Connections");
  }, [navigation]);
  const handleStopThread = useCallback(() => {
    if (
      !selectedThread ||
      (selectedThread.session?.status !== "running" &&
        selectedThread.session?.status !== "starting")
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        ...(selectedThread.session.activeTurnId
          ? { turnId: selectedThread.session.activeTurnId }
          : {}),
      },
    });
  }, [interruptThreadTurn, selectedThread]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [navigation, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [navigation, selectedThread, selectedThreadProject?.workspaceRoot, terminalMenuSessions]);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      navigation,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      terminalMenuSessions,
    ],
  );
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: fileInspector.supported ? handleOpenGitInspector : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitState.gitOperationLabel,
    canOpenTerminal: Boolean(selectedThreadProject?.workspaceRoot),
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts: selectedThreadProject
      ? resolveProjectScripts(
          routeEnvironmentRuntime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          selectedThreadProject,
        )
      : [],
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  const threadCenterHeaderItems = useThreadGitCenterHeaderItems(threadGitControlProps);
  const compactRightHeaderItems = useThreadGitRightHeaderItems(threadGitControlProps);
  const transcriptHeaderItems = useMemo<NativeHeaderItems>(
    () =>
      supportsTranscriptExport
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Thread actions",
              icon: { name: "ellipsis", type: "sfSymbol" as const },
              identifier: "thread-right-actions",
              label: "",
              menu: {
                title: "Thread actions",
                items: [
                  {
                    description: "Copy the complete readable chat",
                    icon: { name: "doc.on.doc", type: "sfSymbol" as const },
                    label: "Copy transcript",
                    onPress: () => void handleCopyTranscript(),
                    type: "action" as const,
                  },
                ],
              },
              type: "menu" as const,
            }),
          ]
        : [],
    [handleCopyTranscript, supportsTranscriptExport],
  );
  const androidTranscriptActions = useMemo<MenuAction[]>(
    () =>
      supportsTranscriptExport
        ? [{ id: "copy-transcript", title: "Copy transcript", image: "doc.on.doc" }]
        : [],
    [supportsTranscriptExport],
  );
  const handleAndroidTranscriptAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      if (event.nativeEvent.event === "copy-transcript") {
        void handleCopyTranscript();
      }
    },
    [handleCopyTranscript],
  );
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      {
        // Match Mail's split-view detail toolbar: the first detail action sits
        // inside the content pane, not flush against the sidebar divider.
        spacing: 18,
        type: "spacing" as const,
      },
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        accessibilityLabel: panes.primarySidebarVisible
          ? "Maximize content"
          : "Show thread sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      withNativeGlassHeaderItem({
        accessibilityLabel: "New task",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        identifier: "thread-left-new-task",
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
        type: "button" as const,
      }),
    ],
    [panes.primarySidebarVisible, props.onReturnToThread, navigation, togglePrimarySidebar],
  );
  const androidHeaderActions = useMemo<ReadonlyArray<AndroidHeaderAction>>(() => {
    if (Platform.OS !== "android") return [];

    const actions: AndroidHeaderAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (selectedThreadCwd !== null) {
      const filesVisible = inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : handleOpenFilesInspector,
      });
    }
    if (selectedThreadProject?.workspaceRoot) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => handleOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: handleOpenGitInspector,
    });
    return actions;
  }, [
    inspectorMode,
    panes.auxiliaryPaneVisible,
    handleOpenFilesInspector,
    handleOpenTerminal,
    handleOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    selectedThreadCwd,
    selectedThreadProject?.workspaceRoot,
  ]);

  const handleEditFailedCreation = useCallback(async () => {
    const creation = selectedThreadCreation?.message;
    if (!creation?.creation || routeThreadIdentity === null) {
      return;
    }
    // The drain restored the prompt and attachments into the recovery draft
    // the rejected creation owns. Open that draft by id: without it the sheet
    // mints a fresh empty one and the restored content is unreachable.
    try {
      await recoverFailedThreadDraft(creation);
    } catch (error) {
      Alert.alert(
        "Could not restore draft",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    clearPendingThreadCreationOutcome(routeThreadIdentity);
    navigation.dispatch(
      StackActions.replace("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          draftId: restoredNewTaskDraftKey(creation.messageId),
          environmentId: String(creation.environmentId),
          projectId: String(creation.creation.projectId),
          ...(selectedThreadProject ? { title: selectedThreadProject.title } : {}),
        },
      }),
    );
  }, [navigation, routeThreadIdentity, selectedThreadCreation, selectedThreadProject]);
  const worktreeSetup = useWorktreeSetup({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    activities: selectedThreadDetail?.activities ?? [],
    preparing:
      selectedThreadCreation?.message.creation?.workspaceMode === "worktree" &&
      selectedThreadCreation.outcome == null,
    turnStarted: selectedThreadDetail?.latestTurn?.startedAt != null,
    followUpSent:
      composer.selectedThreadFeed.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length +
        composer.selectedThreadQueuedMessages.length >
      1,
  });
  const awaitingBootstrapTurn =
    worktreeSetup?.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const handleCancelWorktreeSetup = useCallback(() => {
    if (!selectedThread) return;
    void cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  }, [cancelWorktreeSetup, selectedThread]);
  const [localResendMessageId, setLocalResendMessageId] = useState<string | null>(null);
  const handleWorkLocally = useCallback(async () => {
    if (!selectedThread || !selectedThreadCreation) return;
    const result = await cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
    if (result._tag === "Success" && result.value.cancelled) {
      setLocalResendMessageId(selectedThreadCreation.message.messageId);
    }
  }, [cancelWorktreeSetup, selectedThread, selectedThreadCreation]);
  // Wait for the outbox to restore the cancelled send before queuing its replacement.
  useEffect(() => {
    const pending = selectedThreadCreation;
    if (
      !localResendMessageId ||
      pending?.message.messageId !== localResendMessageId ||
      pending.outcome?.kind !== "failed"
    )
      return;
    setLocalResendMessageId(null);
    const original = pending.message;
    if (!original.creation) return;
    const metadata = makeTurnCommandMetadata();
    const replacement = {
      ...original,
      commandId: CommandId.make(metadata.commandId),
      messageId: MessageId.make(metadata.messageId),
      threadId: ThreadId.make(metadata.threadId),
      createdAt: metadata.createdAt,
      creation: {
        ...original.creation,
        workspaceMode: "local" as const,
        branch: null,
        worktreePath: null,
      },
    };
    void enqueueThreadOutboxMessage(replacement)
      .then(() => {
        const draftKey = restoredNewTaskDraftKey(original.messageId);
        const restored = getComposerDraftSnapshot(draftKey);
        // Leave any edits made during cancellation in their recovery draft.
        if (
          restored.text === original.text &&
          JSON.stringify(restored.context) === JSON.stringify(original.context) &&
          restored.attachments.length === original.attachments.length &&
          restored.attachments.every(
            (attachment, index) => attachment.id === original.attachments[index]?.id,
          )
        ) {
          clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
        }
        clearPendingThreadCreationOutcome(
          scopedThreadKey(original.environmentId, original.threadId),
        );
        navigation.dispatch(
          StackActions.replace("Thread", {
            environmentId: String(replacement.environmentId),
            threadId: String(replacement.threadId),
          }),
        );
      })
      .catch((error) =>
        Alert.alert(
          "Could not work locally",
          error instanceof Error ? error.message : String(error),
        ),
      );
  }, [localResendMessageId, navigation, selectedThreadCreation]);
  const creationState = ((): ThreadDetailScreenProps["creationState"] => {
    if (selectedThreadCreation === null) {
      return awaitingBootstrapTurn ? { kind: "preparing", preparingWorktree: true } : null;
    }
    if (selectedThreadCreation.outcome?.kind === "failed") {
      return {
        kind: "failed",
        reason: selectedThreadCreation.outcome.reason,
        onEditTask: handleEditFailedCreation,
      };
    }
    return {
      kind: "preparing",
      preparingWorktree: selectedThreadCreation.message.creation?.workspaceMode === "worktree",
    };
  })();
  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to threads list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  // A queued creation renders as ready content: its prompt is the whole
  // conversation until the server creates the thread. The subscription's
  // not-found error for that window is expected, not a load failure.
  const contentPresentation =
    creationState !== null
      ? { kind: "ready" as const }
      : projectThreadContentPresentation({
          hasDetail: selectedThreadDetail !== null,
          detailError: Option.getOrNull(selectedThreadDetailState.error),
          detailDeleted: selectedThreadDetailState.status === "deleted",
          connectionState: routeConnectionState,
        });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const renderThreadRouteBody = (showActionControls: boolean) => (
    <>
      <ThreadGitControls {...threadGitControlProps} showActionControls={showActionControls} />

      <GitActionProgressOverlay progress={gitActionProgress} onDismiss={dismissGitActionResult} />

      <View
        className={Platform.OS === "android" ? "flex-1 bg-thread-canvas" : "flex-1 bg-screen"}
        style={
          Platform.OS === "android"
            ? {
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : undefined
        }
      >
        <ThreadDetailScreen
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          feedbackSubmissions={composer.feedbackSubmissions}
          onDismissFeedback={composer.dismissFeedback}
          selectedThreadFeed={composer.selectedThreadFeed}
          activeWorkStartedAt={composer.activeWorkStartedAt}
          isCompacting={composer.isCompacting}
          creationState={creationState}
          setupWorkingStartedAt={
            composer.activeWorkStartedAt !== null &&
            selectedThreadDetail?.activities.some(
              (activity) => activity.kind === "worktree-setup",
            ) &&
            composer.selectedThreadFeed.filter(
              (entry) => entry.type === "message" && entry.message.role === "user",
            ).length <= 1
              ? composer.activeWorkStartedAt
              : null
          }
          worktreeSetup={
            worktreeSetup
              ? {
                  snapshot: worktreeSetup,
                  turnStartedAt: selectedThreadDetail?.latestTurn?.startedAt ?? null,
                  working: composer.activeWorkStartedAt !== null,
                  turnStarted: selectedThreadDetail?.latestTurn?.startedAt != null,
                  onCancel: handleCancelWorktreeSetup,
                  onWorkLocally:
                    selectedThreadCreation?.outcome == null && selectedThreadCreation
                      ? handleWorkLocally
                      : null,
                }
              : null
          }
          activePendingApproval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          draftMessage={composer.draftMessage}
          draftAttachments={composer.draftAttachments}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          loadEarlier={loadEarlierTurns}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          selectedThreadProviderSelectionPendingCount={
            composer.selectedThreadProviderSelectionPendingCount
          }
          queuedMessages={composer.selectedThreadQueuedMessages}
          dispatchingMessageId={composer.dispatchingQueuedMessageId}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onNativePasteText={composer.onNativePasteText}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={awaitingBootstrapTurn ? handleCancelWorktreeSetup : handleStopThread}
          forkableAssistantMessageIds={forkableAssistantMessageIds}
          onForkAssistantMessage={
            canForkConversation && !forkPending ? handleForkAssistantMessage : undefined
          }
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          onUpdateThreadModelSelection={composer.onUpdateModelSelection}
          onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onUpdateThreadProviderRoutingMode={composer.onUpdateProviderRoutingMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
          onDismissUserInput={requests.onDismissUserInput}
        />
      </View>
    </>
  );

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <NativeStackScreenOptions
        optionsVersion={[threadGitControlProps.projectScripts, supportsTranscriptExport]}
        options={{
          // Android draws its own in-flow header (AndroidScreenHeader below);
          // the native stack header stays iOS-only.
          headerShown: Platform.OS !== "android",
          headerTitle: selectedThread.title,
          headerTitleStyle: usesNativeHeaderGlass
            ? {
                fontSize: 17,
                fontWeight: "800",
              }
            : undefined,
          title: selectedThread.title,
          headerBackVisible: !layout.usesSplitView,
          // Compact uses the NATIVE back button when a previous route exists;
          // deep links / cold starts get an explicit Home button instead.
          // Split view always uses its custom left items.
          unstable_headerLeftItems:
            Platform.OS === "ios"
              ? layout.usesSplitView
                ? () => splitLeftHeaderItems
                : canGoBack
                  ? undefined
                  : () => compactHomeHeaderItems
              : undefined,
          // Search lives in the persistent sidebar, so the split header keeps
          // the git controls on the RIGHT (no center items — center space is
          // reserved for future breadcrumbs/status).
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => [
                  ...(layout.usesSplitView ? threadCenterHeaderItems : compactRightHeaderItems),
                  ...transcriptHeaderItems,
                ]
              : undefined,
          unstable_headerSubtitle: usesNativeHeaderGlass ? headerSubtitle : undefined,
          contentStyle:
            Platform.OS === "android" && true ? { backgroundColor: headerColor } : undefined,
        }}
      />

      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={selectedThread.title}
          subtitle={headerSubtitle}
          leading={<AndroidWorkspaceSidebarButton />}
          trailing={
            fileInspector.supported && selectedThreadCwd !== null ? (
              <AndroidHeaderIconButton
                accessibilityLabel={
                  inspectorMode !== null && panes.auxiliaryPaneVisible
                    ? "Hide inspector"
                    : "Show inspector"
                }
                icon="sidebar.right"
                selected={inspectorMode !== null && panes.auxiliaryPaneVisible}
                onPress={handleToggleInspector}
              />
            ) : null
          }
          onBack={
            layout.usesSplitView
              ? undefined
              : () => {
                  // A deep link or cold start has no previous route; Home is the way out.
                  // Read the history at press time: it changes without re-rendering this screen.
                  if (navigation.canGoBack()) navigation.goBack();
                  else navigation.dispatch(StackActions.replace("Home"));
                }
          }
          actions={androidHeaderActions}
          trailing={
            androidTranscriptActions.length > 0 ? (
              <ControlPillMenu
                actions={androidTranscriptActions}
                isAnchoredToRight
                title="Thread actions"
                onPressAction={handleAndroidTranscriptAction}
              >
                <AndroidHeaderIconButton accessibilityLabel="Thread actions" icon="ellipsis" />
              </ControlPillMenu>
            ) : undefined
          }
          hideBottomBorder
        />
      ) : null}

      {/* Android surfaces the git/files/inspector actions in its in-flow
          header above, so the fallback action toolbar stays iOS-only. */}
      {renderThreadRouteBody(
        Platform.OS !== "android" && !layout.usesSplitView && !usesNativeHeaderGlass,
      )}

      {forkModelPicker && serverConfig ? (
        <ForkConversationSheet
          state={forkModelPicker}
          serverConfig={serverConfig}
          options={forkModelOptions}
          onCancel={() => setForkModelPicker(null)}
          onSelectModel={handleForkModelSelect}
          onConfirm={() => void handleForkModelConfirm()}
        />
      ) : null}
    </>
  );
}
