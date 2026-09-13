import type {
  DesktopT3MigrationInspection,
  DesktopT3MigrationStartResult,
  DesktopT3MigrationSummary,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  FolderGit2Icon,
  InfoIcon,
  MessagesSquareIcon,
  MonitorIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  getT3DesktopMigrationBridge,
  migrationReasonMessage,
  shouldOfferT3MigrationOnboarding,
  type T3DesktopMigrationBridge,
} from "./T3DesktopMigration.logic";

type FlowState =
  | { readonly type: "loading" }
  | { readonly type: "inspection"; readonly inspection: DesktopT3MigrationInspection }
  | { readonly type: "confirm-replace"; readonly summary: DesktopT3MigrationSummary }
  | { readonly type: "dismissing" }
  | { readonly type: "switching" }
  | {
      readonly type: "completed";
      readonly result: Extract<DesktopT3MigrationStartResult, { status: "completed" }>;
    }
  | { readonly type: "error"; readonly message: string };

const GENERIC_INSPECTION_ERROR =
  "Hotlap could not check the T3 Code workspace. Nothing was changed.";
const GENERIC_START_ERROR =
  "Hotlap could not complete the switch. Your T3 Code data was not changed.";

async function readInspection(bridge: T3DesktopMigrationBridge): Promise<FlowState> {
  try {
    return { type: "inspection", inspection: await bridge.inspectT3DesktopMigration() };
  } catch {
    return { type: "error", message: GENERIC_INSPECTION_ERROR };
  }
}

function MigrationSummary({ summary }: { readonly summary: DesktopT3MigrationSummary }) {
  const counts = [
    { label: "Projects", value: summary.projectCount, Icon: FolderGit2Icon },
    { label: "Threads", value: summary.threadCount, Icon: MessagesSquareIcon },
    { label: "Computer", value: "This Mac", Icon: MonitorIcon },
  ] as const;

  return (
    <dl className="grid grid-cols-3 gap-2" aria-label="Migration summary">
      {counts.map(({ label, value, Icon }) => (
        <div key={label} className="rounded-lg border border-border bg-background p-3">
          <Icon className="mb-2 size-4 text-muted-foreground" aria-hidden />
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReadyFlow({
  summary,
  showDismiss,
  onDismiss,
  onStart,
}: {
  readonly summary: DesktopT3MigrationSummary;
  readonly showDismiss: boolean;
  readonly onDismiss: () => void;
  readonly onStart: () => void;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Continue from T3 Code
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          We found your local T3 Code workspace. Switch it to Hotlap with a recoverable backup.
        </p>
      </div>
      <MigrationSummary summary={summary} />
      <div className="rounded-lg border border-border bg-background px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckIcon className="size-4 text-emerald-500" aria-hidden />
          Ready to switch
        </div>
        <p className="mt-1 pl-6 text-xs text-muted-foreground">
          Projects, threads, attachments, settings, prompts, and sign-ins will move.
        </p>
      </div>
      <div className="flex gap-2 rounded-lg bg-muted/45 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          Drafts, saved remote connections, and browser or cloud sessions need to be set up again.
          {summary.pairingTransfer === "re-pair-required"
            ? " Connected devices will also need to pair again."
            : ""}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        {showDismiss ? (
          <Button aria-label="Not now" onClick={onDismiss} variant="ghost">
            Not now
          </Button>
        ) : null}
        <Button aria-label="Switch to Hotlap" onClick={onStart}>
          Switch to Hotlap
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </>
  );
}

export function T3DesktopMigrationFlow({
  bridge,
  surface,
  onContinue,
  onUnavailable,
  onBusyChange,
}: {
  readonly bridge: T3DesktopMigrationBridge;
  readonly surface: "onboarding" | "settings";
  readonly onContinue?: () => void;
  readonly onUnavailable?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [state, setState] = useState<FlowState>({ type: "loading" });

  const inspect = useCallback(async () => {
    setState({ type: "loading" });
    setState(await readInspection(bridge));
  }, [bridge]);

  useEffect(() => {
    let active = true;
    void readInspection(bridge).then((inspection) => {
      if (active) setState(inspection);
    });
    return () => {
      active = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (surface !== "onboarding" || state.type !== "inspection") return;
    if (!shouldOfferT3MigrationOnboarding(state.inspection)) onUnavailable?.();
  }, [onUnavailable, state, surface]);

  const busy = state.type === "switching" || state.type === "dismissing";
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const dismiss = async () => {
    setState({ type: "dismissing" });
    try {
      await bridge.dismissT3DesktopMigration();
      onContinue?.();
    } catch {
      setState({
        type: "error",
        message: "Hotlap could not save this choice. Nothing was changed.",
      });
    }
  };

  const start = async (replaceExisting: boolean) => {
    setState({ type: "switching" });
    let result: DesktopT3MigrationStartResult;
    try {
      result = await bridge.startT3DesktopMigration({ replaceExisting });
    } catch {
      setState({ type: "error", message: GENERIC_START_ERROR });
      return;
    }

    if (result.status === "completed") {
      setState({ type: "completed", result });
      return;
    }
    if (result.status === "error") {
      setState({ type: "error", message: result.message });
      return;
    }
    setState({
      type: "inspection",
      inspection: { status: "blocked", reason: result.reason, dismissed: false },
    });
  };

  if (state.type === "loading") {
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        Checking for T3 Code data…
      </p>
    );
  }

  if (state.type === "switching" || state.type === "dismissing") {
    return (
      <div className="space-y-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {state.type === "switching"
            ? "Switching to Hotlap. Keep this app open…"
            : "Saving your choice…"}
        </p>
        <Button disabled>{state.type === "switching" ? "Switching…" : "Saving…"}</Button>
      </div>
    );
  }

  if (state.type === "completed") {
    return (
      <div className="space-y-3" role="status" aria-live="polite">
        <h1 className="text-2xl font-semibold tracking-tight">Switch complete</h1>
        <p className="text-sm text-muted-foreground">
          Hotlap will relaunch with your T3 Code workspace.
          {state.result.pairingTransfer === "re-pair-required"
            ? " Pair your other devices again after relaunch."
            : ""}
        </p>
      </div>
    );
  }

  if (state.type === "error") {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
        <div className="flex justify-end gap-2">
          {surface === "onboarding" ? (
            <Button variant="ghost" onClick={() => void dismiss()}>
              Not now
            </Button>
          ) : null}
          <Button onClick={() => void inspect()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (state.type === "confirm-replace") {
    return (
      <div className="space-y-4">
        <div role="alert" className="space-y-2">
          <h1 className="text-xl font-semibold">Hotlap already has data</h1>
          <p className="text-sm text-muted-foreground">
            Hotlap will keep that data in a backup, then replace it with your T3 Code workspace. The
            two workspaces will not be merged.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              setState({
                type: "inspection",
                inspection: { status: "ready", dismissed: false, summary: state.summary },
              })
            }
          >
            Back
          </Button>
          <Button aria-label="Back up and replace" onClick={() => void start(true)}>
            Back up and replace
          </Button>
        </div>
      </div>
    );
  }

  const { inspection } = state;
  if (inspection.status === "ready") {
    return (
      <ReadyFlow
        summary={inspection.summary}
        showDismiss={surface === "onboarding"}
        onDismiss={() => void dismiss()}
        onStart={() =>
          inspection.summary.destinationHasData
            ? setState({ type: "confirm-replace", summary: inspection.summary })
            : void start(false)
        }
      />
    );
  }

  if (inspection.status === "blocked") {
    return (
      <div className="space-y-4">
        <div role="alert" className="space-y-2">
          <h1 className="text-xl font-semibold">T3 Code isn’t ready to switch</h1>
          <p className="text-sm text-muted-foreground">
            {migrationReasonMessage(inspection.reason)}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          {surface === "onboarding" ? (
            <Button variant="ghost" onClick={() => void dismiss()}>
              Not now
            </Button>
          ) : null}
          <Button onClick={() => void inspect()}>Check again</Button>
        </div>
      </div>
    );
  }

  if (inspection.status === "completed") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        This Mac has already switched from T3 Code.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p role="alert" className="text-sm text-muted-foreground">
        {migrationReasonMessage(inspection.reason)}
      </p>
      <Button onClick={() => void inspect()}>Check again</Button>
    </div>
  );
}

export function T3DesktopMigrationSettings() {
  const bridge = getT3DesktopMigrationBridge(
    typeof window === "undefined" ? undefined : window.desktopBridge,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!bridge) return null;

  return (
    <Dialog
      open={open}
      disablePointerDismissal={busy}
      onOpenChange={(nextOpen, event) => {
        if (busy) {
          event.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        Switch from T3 Code
      </DialogTrigger>
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Switch from T3 Code</DialogTitle>
          <DialogDescription>
            Move this Mac’s supported T3 Code workspace into Hotlap once.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <T3DesktopMigrationFlow bridge={bridge} surface="settings" onBusyChange={setBusy} />
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy} variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
