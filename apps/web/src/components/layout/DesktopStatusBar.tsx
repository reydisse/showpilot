import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParams } from "@tanstack/react-router";
import { Download, Laptop, MonitorPlay, PanelTopOpen, RadioTower, RefreshCw, Timer, UserCheck } from "lucide-react";
import { configureDesktopLocalDevices } from "@/lib/desktop-local-devices";
import { getDesktopActions, desktopOperationPending, desktopRead, type DesktopOperation } from "@/lib/desktop-operations";
import { useDesktopBridgeStatus } from "@/hooks/useDesktopBridgeStatus";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { DesktopNotificationNotice } from "./DesktopNotificationNotice";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  getDesktopEngineInfo,
  checkDesktopUpdate,
  installDesktopUpdate,
  isDesktopLocalDeviceMode,
  openDesktopWindow,
  openDesktopLocalShow,
  stopDesktopBridge,
  type DesktopEngineInfo,
  type DesktopWindowKind,
} from "@/lib/desktop-runtime";

const ConfidenceToolbar = lazy(() => import("@/components/confidence/ConfidenceToolbar").then((module) => ({ default: module.ConfidenceToolbar })));

const DesktopLocalShowNotice = lazy(() => import("./DesktopLocalShowNotice").then((module) => ({ default: module.DesktopLocalShowNotice })));

const WINDOW_ACTIONS: Array<{
  kind: DesktopWindowKind;
  label: string;
  icon: typeof Timer;
}> = [
  { kind: "timer", label: "Timer window", icon: Timer },
  { kind: "show-board", label: "Crew status", icon: MonitorPlay },
  { kind: "check-in", label: "Check-in", icon: UserCheck },
];

function useOperation<T>(operation: DesktopOperation<T>) {
  return useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
}

export function DesktopStatusBar({ orgId }: { orgId?: string } = {}) {
  const { slug } = useParams({ strict: false });
  const desktop = useDesktopRuntime();
  const actions = getDesktopActions();
  const windowAction = useOperation(actions.window);
  const localShowAction = useOperation(actions.localShow);
  const bridgeAction = useOperation(actions.bridge);
  const checkAction = useOperation(actions.check);
  const installAction = useOperation(actions.install);
  const [engine, setEngine] = useState<DesktopEngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineAttempt, setEngineAttempt] = useState(0);
  const { status: bridge, error: bridgeError, refresh: refreshBridge } = useDesktopBridgeStatus(desktop);
  const refreshBridgeRef = useRef(refreshBridge); refreshBridgeRef.current = refreshBridge;
  const owner = useMemo(() => ({ active: false }), [desktop, slug, orgId]);
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const active = () => owner.active && currentOwner.current === owner;
  const confirmation = useRef<object | null>(null);
  const [confirming, setConfirming] = useState<object | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  useEffect(() => { owner.active = desktop; return () => { owner.active = false; }; }, [owner, desktop]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setEngineError(null);
    void desktopRead(getDesktopEngineInfo, 12000, "The local engine has not replied. Retry the connection check.").then(info => {
      if (active) setEngine(info);
    }, cause => {
      if (active) setEngineError(cause instanceof Error ? cause.message : "Native engine unavailable");
    });
    return () => { active = false; };
  }, [desktop, engineAttempt]);

  useEffect(() => {
    if (!desktop) return;
    const timer = setTimeout(() => {
      if (actions.check.getSnapshot().kind === "idle" && actions.install.getSnapshot().kind === "idle")
        actions.check.start("Update check", checkDesktopUpdate, 35000);
    }, 3000);
    return () => clearTimeout(timer);
  }, [desktop, actions]);
  useEffect(() => {
    if (desktop && (bridgeAction.kind === "complete" || bridgeAction.kind === "failed")) refreshBridgeRef.current();
  }, [desktop, bridgeAction]);

  if (!desktop) return null;
  const bridgeBusy = desktopOperationPending(bridgeAction) || confirming === owner;
  const busy = desktopOperationPending(windowAction);
  const update = checkAction.kind === "complete" ? checkAction.value : null;
  const installed = installAction.kind === "complete" ? installAction.value : null;
  const updateBusy = desktopOperationPending(checkAction) || desktopOperationPending(installAction) || confirming === owner || !!installed;
  const localDevicesEnabled = isDesktopLocalDeviceMode(bridge);
  const bridgeFailed = Boolean(
    localDevicesEnabled
      && (bridge?.connection === "unauthorized"
        || bridge?.connection === "error"
        || (!bridge?.running && bridge?.lastError)),
  );
  const bridgeLabel = bridgeError
    ? "Local device status unavailable"
    : !localDevicesEnabled
      ? "Venue Bridge mode"
      : bridge?.connection === "connected"
        ? "This computer controls local devices"
        : bridge?.connection === "unauthorized"
          ? "Local device key rejected"
          : bridge?.connection === "error"
            ? "Local device connection failed"
            : bridge?.connection === "disconnected"
              ? "Local device connection lost"
              : bridge?.running
                ? "Connecting this computer…"
                : bridgeFailed
                  ? "Local device engine failed"
                  : "Local device engine restarting…";
  const bridgeDetail = !localDevicesEnabled
    ? "Remote commands use the Bridge installed on the venue network."
    : bridge?.lastError ?? bridgeError ?? bridge?.logs.at(-1);

  async function approve(options: Parameters<typeof confirm>[0]) {
    if (!active() || confirmation.current) return false;
    confirmation.current = owner; setConfirming(owner);
    try { return await confirm(options) && active(); }
    finally { if (confirmation.current === owner) { confirmation.current = null; setConfirming(null); } }
  }
  const toggleLocalDevices = async () => {
    if (!slug || bridgeBusy || !active()) return;
    const approved = await approve(localDevicesEnabled ? {
      title: "Use the venue Bridge?",
      description: "This stops this computer's local device engine. Confirm that the venue Bridge is ready before switching during a show.",
      confirmLabel: "Use venue Bridge", variant: "warning",
    } : {
      title: "Use this computer for local devices?",
      description: "Only enable this on the computer connected to the equipment network. It will enable this computer's device agent; an existing active venue Bridge is kept until you explicitly take over in Settings.",
      confirmLabel: "Use this computer", variant: "warning",
    });
    if (!approved) return;
    actions.bridge.start("Local device change", async withinDeadline => {
      if (!active() || !withinDeadline()) return;
      if (localDevicesEnabled) await stopDesktopBridge();
      else await configureDesktopLocalDevices(slug, true, () => active() && withinDeadline());
    });
  };
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
    { state: localShowAction, operation: actions.localShow },
    { state: bridgeAction, operation: actions.bridge },
    { state: checkAction, operation: actions.check },
    { state: installAction, operation: actions.install },
  ];
  return (
    <>
    <div role="region" aria-label="Desktop controls" tabIndex={0} className="modern-scrollbar max-h-[35dvh] shrink-0 overflow-y-auto focus-visible:outline-2 focus-visible:outline-fire-500">
    <DesktopNotificationNotice />
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-board-border bg-board-card px-3 py-1 text-xs text-board-muted">
      <span className="flex items-center gap-1.5 font-semibold text-fire-400">
        <PanelTopOpen className="h-3.5 w-3.5" />
        Desktop
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${engine?.native ? "bg-green-500" : "bg-fire-500 animate-pulse"}`}
        />
        {engine?.native
          ? `Local engine ${engine.version} · ${engine.platform}`
          : engineError ?? "Connecting to local engine…"}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            !localDevicesEnabled
              ? "bg-sky-500"
              : bridge?.connection === "connected"
                ? "bg-green-500"
                : bridgeFailed || bridgeError
                  ? "bg-red-500"
                  : "animate-pulse bg-amber-400"
          }`}
        />
        <span title={bridgeDetail}>{bridgeLabel}</span>
        {slug ? (
          <button
            type="button"
            disabled={bridgeBusy || !bridge || !!bridgeError}
            onClick={() => void toggleLocalDevices()}
            title={
              localDevicesEnabled
                ? "Stop this computer's embedded Bridge and use the Bridge at the venue"
                : "Use this computer only when it is connected to the equipment network"
            }
            className="ml-1 flex min-h-11 items-center gap-1 rounded px-2 py-1 font-medium text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
          >
            {localDevicesEnabled ? <RadioTower className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}
            {bridgeBusy
              ? "Switching…"
              : localDevicesEnabled
                ? "Use venue Bridge"
                : "Use this computer"}
          </button>
        ) : null}
      </span>
      {bridgeError ? (
        <span role="alert" className="max-w-80 break-words text-red-400" title={bridgeError}>
          {bridgeError}
        </span>
      ) : null}
      <Suspense fallback={null}><DesktopLocalShowNotice orgId={orgId} slug={slug} /></Suspense>
      <div className="ml-auto flex max-w-full flex-wrap items-center gap-1 [&>button]:whitespace-nowrap">
        <button
          type="button"
          disabled={desktopOperationPending(localShowAction)}
          onClick={() => actions.localShow.start("Local show", async () => {
            try { await openDesktopLocalShow(); }
            catch { throw new Error("The local workspace could not open. Update ShowPilot Desktop and try again."); }
          })}
          title="Open this computer's prepared show and local controls"
          className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text"
        >
          <Laptop className="h-3 w-3" /> Local show
        </button>
        <button
          type="button"
          disabled={updateBusy}
          onClick={() => void handleUpdate()}
          title="Check for signed Desktop updates"
          className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
        >
          {update ? <Download className="h-3 w-3" /> : <RefreshCw className={`h-3 w-3 ${checkAction.kind === "pending" ? "animate-spin" : ""}`} />}
          {installed ? installed.restartRequired ? "Restart required" : "Restart requested"
            : installAction.kind === "unconfirmed" ? "Installation not confirmed"
            : installAction.kind === "pending" ? "Installing…"
            : checkAction.kind === "unconfirmed" ? "Update check pending"
            : checkAction.kind === "pending" ? "Checking…"
            : update ? `Update ${update.version}`
            : checkAction.kind === "complete" ? "Up to date"
            : checkAction.kind === "failed" ? "Retry update" : "Check update"}
        </button>
        {slug && <Suspense fallback={null}><ConfidenceToolbar key={slug} slug={slug} orgId={orgId} /></Suspense>}
        {slug
          ? WINDOW_ACTIONS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => openWindow(kind, label)}
              className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
            >
              <Icon className="h-3 w-3" />
              {(windowAction.kind === "pending" || windowAction.kind === "unconfirmed") && windowAction.label === label ? windowAction.kind === "unconfirmed" ? `${label} pending` : "Opening…" : label}
            </button>
          ))
          : null}
      </div>
    </div>
    {installed ? (
      <div role="status" className="border-b border-fire-500/30 bg-fire-500/10 px-3 py-2 text-xs text-fire-300">
        {installed.restartRequired ? "Update installed. Choose Quit ShowPilot from the app menu, then reopen it to finish." : "Update installed and restart requested. If this window remains open, quit ShowPilot and reopen it to finish."}
      </div>
    ) : null}
    {engineError && <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-red-500/30 px-3 py-2 text-xs text-red-300"><span>{engineError}</span><button className="min-h-11 rounded border px-3" onClick={() => setEngineAttempt(value => value + 1)}>Retry local engine</button></div>}
    {bridgeError && <button className="min-h-11 self-start rounded border border-board-border px-3 text-xs text-board-text" onClick={refreshBridge}>Retry local status</button>}
    {notices.map(({ state, operation }, index) => state.kind === "failed" || state.kind === "unconfirmed" ? (
      <div key={index} role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        <span className="min-w-0 flex-1 break-words">{state.kind === "failed" ? state.message : state.label === "Desktop installation"
          ? "Desktop installation has not confirmed completion. It may still be running. Keep ShowPilot open; another installation will not start while this one is unresolved."
          : `${state.label} has not confirmed completion. It may still finish. Other controls remain available.`}</span>
        {state.kind === "failed" && <button type="button" onClick={() => operation.dismiss()} className="min-h-11 shrink-0 rounded px-3 hover:bg-red-500/15">Dismiss</button>}
      </div>
    ) : null)}
    </div>
    {ConfirmDialogEl}
    </>
  );
}
