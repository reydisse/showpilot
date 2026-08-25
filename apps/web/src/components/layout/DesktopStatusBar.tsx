import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Download, Laptop, MonitorPlay, PanelTopOpen, RadioTower, RefreshCw, Timer, UserCheck } from "lucide-react";
import { configureDesktopLocalDevices } from "@/lib/desktop-local-devices";
import {
  getDesktopBridgeStatus,
  getDesktopEngineInfo,
  checkDesktopUpdate,
  installDesktopUpdate,
  isDesktopRuntime,
  openDesktopWindow,
  stopDesktopBridge,
  type DesktopBridgeStatus,
  type DesktopEngineInfo,
  type DesktopWindowKind,
  type DesktopUpdateInfo,
} from "@/lib/desktop-runtime";

const WINDOW_ACTIONS: Array<{
  kind: DesktopWindowKind;
  label: string;
  icon: typeof Timer;
}> = [
  { kind: "timer", label: "Timer window", icon: Timer },
  { kind: "show-board", label: "Show Board", icon: MonitorPlay },
  { kind: "check-in", label: "Check-in", icon: UserCheck },
];

export function DesktopStatusBar() {
  const { slug } = useParams({ strict: false });
  const [engine, setEngine] = useState<DesktopEngineInfo | null>(null);
  const [bridge, setBridge] = useState<DesktopBridgeStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [busy, setBusy] = useState<DesktopWindowKind | null>(null);
  const [update, setUpdate] = useState<DesktopUpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "current" | "installing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void getDesktopEngineInfo()
      .then((info) => {
        if (active) setEngine(info);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Native engine unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void checkDesktopUpdate()
        .then((available) => {
          if (active && available) setUpdate(available);
        })
        .catch(() => {
          // A manual check below reports endpoint or network failures.
        });
    }, 3_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const refresh = () => {
      void getDesktopBridgeStatus()
        .then((status) => {
          if (active) {
            setBridge(status);
            setBridgeError(null);
          }
        })
        .catch((cause) => {
          if (active) {
            setBridgeError(
              cause instanceof Error ? cause.message : "Local device status unavailable",
            );
          }
        });
    };
    refresh();
    const timer = window.setInterval(() => {
      refresh();
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [desktop]);

  if (!desktop) return null;

  const localDevicesEnabled = bridge?.localDevicesEnabled ?? false;
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

  const toggleLocalDevices = async () => {
    if (!slug || bridgeBusy) return;
    if (
      !localDevicesEnabled
      && !window.confirm(
        "Use this computer for local devices? Only enable this on the computer connected to the equipment network. It will replace the venue Bridge as the active device agent.",
      )
    ) {
      return;
    }

    setBridgeBusy(true);
    setBridgeError(null);
    try {
      if (localDevicesEnabled) {
        await stopDesktopBridge();
      } else {
        await configureDesktopLocalDevices(slug, true);
      }
      setBridge(await getDesktopBridgeStatus());
    } catch (cause) {
      setBridgeError(cause instanceof Error ? cause.message : "Could not change device mode");
    } finally {
      setBridgeBusy(false);
    }
  };

  const openWindow = async (kind: DesktopWindowKind) => {
    if (!slug) return;
    setBusy(kind);
    setError(null);
    try {
      await openDesktopWindow(kind, slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open desktop window");
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async () => {
    if (updateState === "checking" || updateState === "installing") return;
    if (update) {
      if (!window.confirm(`Install ShowPilot Desktop ${update.version} and restart now?`)) return;
      setUpdateState("installing");
      try {
        const installed = await installDesktopUpdate();
        if (!installed) {
          setUpdate(null);
          setUpdateState("current");
        }
      } catch (cause) {
        setUpdateState("error");
        setError(cause instanceof Error ? cause.message : "Desktop update failed");
      }
      return;
    }

    setUpdateState("checking");
    try {
      const available = await checkDesktopUpdate();
      setUpdate(available);
      setUpdateState(available ? "idle" : "current");
    } catch (cause) {
      setUpdateState("error");
      setError(cause instanceof Error ? cause.message : "Could not check for updates");
    }
  };

  return (
    <div className="flex min-h-8 shrink-0 items-center gap-3 border-b border-board-border bg-board-card px-3 text-[10px] text-board-muted">
      <span className="flex items-center gap-1.5 font-semibold text-fire-400">
        <PanelTopOpen className="h-3.5 w-3.5" />
        Desktop
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${engine?.native ? "bg-green-500" : "bg-fire-500 animate-pulse"}`}
        />
        {engine?.native
          ? `Local engine ${engine.version} · ${engine.platform}`
          : error ?? "Connecting to local engine…"}
      </span>
      <span className="flex items-center gap-1.5">
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
            disabled={bridgeBusy}
            onClick={() => void toggleLocalDevices()}
            title={
              localDevicesEnabled
                ? "Stop this computer's embedded Bridge and use the Bridge at the venue"
                : "Use this computer only when it is connected to the equipment network"
            }
            className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
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
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled={updateState === "checking" || updateState === "installing"}
          onClick={() => void handleUpdate()}
          title={updateState === "error" ? error ?? "Desktop update failed" : "Check for signed Desktop updates"}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
        >
          {update ? <Download className="h-3 w-3" /> : <RefreshCw className={`h-3 w-3 ${updateState === "checking" ? "animate-spin" : ""}`} />}
          {updateState === "installing"
            ? "Installing…"
            : update
              ? `Update ${update.version}`
              : updateState === "checking"
                ? "Checking…"
                : updateState === "current"
                  ? "Up to date"
                  : updateState === "error"
                    ? "Retry update"
                    : "Check update"}
        </button>
        {slug
          ? WINDOW_ACTIONS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              disabled={busy !== null}
              onClick={() => void openWindow(kind)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-board-muted transition hover:bg-board-border/60 hover:text-board-text disabled:opacity-50"
            >
              <Icon className="h-3 w-3" />
              {busy === kind ? "Opening…" : label}
            </button>
          ))
          : null}
      </div>
    </div>
  );
}
