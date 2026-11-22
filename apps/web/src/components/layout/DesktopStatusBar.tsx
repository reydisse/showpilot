import { QuietActivity } from "@/components/ui/QuietActivity";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { Download, MonitorPlay, MoreHorizontal, PanelTopOpen, RefreshCw, Timer, UserCheck } from "lucide-react";
import { Popover } from "radix-ui";
import { getDesktopActions, desktopOperationPending, type DesktopOperation } from "@/lib/desktop-operations";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { DesktopNotificationNotice } from "./DesktopNotificationNotice";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  openDesktopWindow,
  type DesktopWindowKind,
} from "@/lib/desktop-runtime";

const ConfidenceToolbar = lazy(() => import("@/components/confidence/ConfidenceToolbar").then((module) => ({ default: module.ConfidenceToolbar })));

const DesktopLocalShowNotice = lazy(() => import("./DesktopLocalShowNotice").then((module) => ({ default: module.DesktopLocalShowNotice })));

const INLINE_ACTIONS_MIN_WIDTH = 1360;

const WINDOW_ACTIONS: Array<{
  kind: DesktopWindowKind;
  label: string;
  icon: typeof Timer;
}> = [
  { kind: "show-board", label: "Crew status", icon: MonitorPlay },
  { kind: "check-in", label: "Check-in", icon: UserCheck },
];

function useOperation<T>(operation: DesktopOperation<T>) {
  return useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
}

export function DesktopStatusBar({ orgId, liveRundown }: { orgId?: string; liveRundown?: ReactNode } = {}) {
  const { slug } = useParams({ strict: false });
  const desktop = useDesktopRuntime();
  const toolbar = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    const element = toolbar.current;
    if (!desktop || !element) return;
    const measure = (width: number) => { if (width > 0) setCompact(width < INLINE_ACTIONS_MIN_WIDTH); };
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => measure(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [desktop]);
  useEffect(() => { if (!compact) setActionsOpen(false); }, [compact]);
  const actions = getDesktopActions();
  const windowAction = useOperation(actions.window);
  const checkAction = useOperation(actions.check);
  const installAction = useOperation(actions.install);
  const owner = useMemo(() => ({ active: false }), [desktop, slug, orgId]);
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const active = () => owner.active && currentOwner.current === owner;
  const confirmation = useRef<object | null>(null);
  const [confirming, setConfirming] = useState<object | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  useEffect(() => { owner.active = desktop; return () => { owner.active = false; }; }, [owner, desktop]);

  useEffect(() => {
    if (!desktop) return;
    const timer = setTimeout(() => {
      if (actions.check.getSnapshot().kind === "idle" && actions.install.getSnapshot().kind === "idle")
        actions.check.start("Update check", checkDesktopUpdate, 35000);
    }, 3000);
    return () => clearTimeout(timer);
  }, [desktop, actions]);
  if (!desktop) return null;
  const busy = desktopOperationPending(windowAction);
  const update = checkAction.kind === "complete" ? checkAction.value : null;
  const installed = installAction.kind === "complete" ? installAction.value : null;
  const updateBusy = desktopOperationPending(checkAction) || desktopOperationPending(installAction) || confirming === owner || !!installed;
  async function approve(options: Parameters<typeof confirm>[0]) {
    if (!active() || confirmation.current) return false;
    confirmation.current = owner; setConfirming(owner);
    try { return await confirm(options) && active(); }
    finally { if (confirmation.current === owner) { confirmation.current = null; setConfirming(null); } }
  }
  const openWindow = (kind: DesktopWindowKind, label: string) => {
    if (slug && active()) actions.window.start(label, () => openDesktopWindow(kind, slug));
  };
  const handleUpdate = async () => {
    if (updateBusy || !active()) return;
    if (!update) { actions.check.start("Update check", checkDesktopUpdate, 35000); return; }
    const approved = await approve({
      title: `Install ShowPilot Desktop ${update.version}?`,
      description: "ShowPilot will restart to finish the update. Install when your show and local equipment are idle.",
      confirmLabel: "Install and restart", variant: "warning",
    });
    if (approved) actions.install.start("Desktop installation", installDesktopUpdate, 60000);
  };
  const notices = [
    { state: windowAction, operation: actions.window },
    { state: checkAction, operation: actions.check },
    { state: installAction, operation: actions.install },
  ];
  const timerLabel = "Timer window";
  const timerAction = (
        <button
          type="button"
          disabled={busy}
          aria-label={timerLabel}
          onClick={() => openWindow("timer", "Timer window")}
          className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
        >
          <Timer aria-hidden="true" className="h-3 w-3" />
          {timerLabel}
        </button>
  );
  const secondaryActions = (
    <div className={`flex items-center gap-1 [&>button]:whitespace-nowrap ${compact ? "flex-col items-stretch" : ""}`}>
        <button
          type="button"
          disabled={updateBusy}
          aria-label={installed ? "Restart required" : update ? `Update ${update.version}` : "Check update"}
          aria-busy={updateBusy}
          onClick={() => void handleUpdate()}
          title="Check for signed Desktop updates"
          className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
        >
          {update ? <Download className="h-3 w-3" /> : <RefreshCw className={`h-3 w-3 ${checkAction.kind === "pending" ? "animate-spin" : ""}`} />}
          {installed ? "Restart required"
            : installAction.kind === "pending" || installAction.kind === "unconfirmed" || checkAction.kind === "pending" || checkAction.kind === "unconfirmed" ? <QuietActivity label="Checking…" />
            : update ? `Update ${update.version}` : "Check update"}
        </button>

    </div>
  );
  return (
    <>
    <div ref={toolbar} role="region" aria-label="Desktop controls" tabIndex={0} className="modern-scrollbar max-h-[35dvh] shrink-0 overflow-auto focus-visible:outline-2 focus-visible:outline-fire-500">
    <DesktopNotificationNotice />
    <div className="flex min-h-8 min-w-max items-center gap-3 border-b border-board-border bg-board-card px-3 py-1 text-xs text-board-muted">
      <div role="group" aria-label="Desktop status" className="flex shrink-0 items-center gap-3 whitespace-nowrap">
      <span className="flex items-center gap-1.5 font-semibold text-fire-400">
        <PanelTopOpen className="h-3.5 w-3.5" />
        Desktop
      </span>
      <Suspense fallback={null}><DesktopLocalShowNotice orgId={orgId} slug={slug} /></Suspense>
        </div>
      {liveRundown}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!compact && secondaryActions}
        {slug && <Suspense fallback={null}><ConfidenceToolbar key={slug} slug={slug} orgId={orgId} /></Suspense>}
        {compact ? (
          <Popover.Root open={actionsOpen} onOpenChange={setActionsOpen}>
            <Popover.Trigger aria-label="Desktop actions" title="Updates and Timer window" className="flex size-11 shrink-0 items-center justify-center rounded-md text-board-muted hover:bg-board-border/60 hover:text-board-text focus-visible:outline-2 focus-visible:outline-fire-500">
              <MoreHorizontal aria-hidden="true" className="size-5" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content aria-label="Desktop actions" align="end" sideOffset={6} collisionPadding={12} className="z-50 max-h-[70dvh] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-board-border bg-board-card p-2 shadow-xl">
                {secondaryActions}
                {timerAction}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : timerAction}
        {slug
          ? WINDOW_ACTIONS.map(({ kind, label, icon: Icon }) => {
            const actionLabel = label;
            return <button
              key={kind}
              type="button"
              disabled={busy}
              aria-label={actionLabel}
              title={actionLabel}
              onClick={() => openWindow(kind, label)}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
            >
              <Icon aria-hidden="true" className="h-3 w-3" />
              <span className="hidden min-[1400px]:inline">{actionLabel}</span>
            </button>;
          })
          : null}
      </div>
    </div>
    {installed ? (
      <div role="status" className="border-b border-fire-500/30 bg-fire-500/10 px-3 py-2 text-xs text-fire-300">
        {installed.restartRequired ? "Update installed. Choose Quit ShowPilot from the app menu, then reopen it to finish." : "Update installed and restart requested. If this window remains open, quit ShowPilot and reopen it to finish."}
      </div>
    ) : null}
    {notices.filter(({ state }) => state.kind === "failed" || state.kind === "unconfirmed").slice(0, 1).map(({ state, operation }, index) => state.kind === "failed" || state.kind === "unconfirmed" ? (
      <div key={index} role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        <span className="min-w-0 flex-1 break-words">{index === 0 && state.label === "Desktop installation" ? "The update could not finish. Keep ShowPilot open." : state.label === "Update check" ? "Updates could not be checked." : state.label === "Local device change" ? "Local control could not be changed." : "This window could not open."}</span>
        {state.kind === "failed" && <button type="button" onClick={() => operation.dismiss()} className="min-h-11 shrink-0 rounded px-3 hover:bg-red-500/15">Dismiss</button>}
      </div>
    ) : null)}
    </div>
    {ConfirmDialogEl}
    </>
  );
}
