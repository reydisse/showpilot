import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { MonitorPlay, PanelTopOpen, Timer, UserCheck } from "lucide-react";
import {
  getDesktopBridgeStatus,
  getDesktopEngineInfo,
  isDesktopRuntime,
  openDesktopWindow,
  type DesktopBridgeStatus,
  type DesktopEngineInfo,
  type DesktopWindowKind,
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
  const [busy, setBusy] = useState<DesktopWindowKind | null>(null);
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
    void getDesktopBridgeStatus().then((status) => {
      if (active) setBridge(status);
    });
    const timer = window.setInterval(() => {
      void getDesktopBridgeStatus().then((status) => {
        if (active) setBridge(status);
      });
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [desktop]);

  if (!desktop) return null;

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
        <span className={`h-1.5 w-1.5 rounded-full ${bridge?.running ? "bg-green-500" : "bg-amber-400"}`} />
        <span title={bridge?.logs.at(-1)}>
          {bridge?.running
            ? "Local devices ready"
            : bridge?.configured
              ? "Local devices reconnecting…"
              : "Local devices need an API key"}
        </span>
      </span>
      {slug ? (
        <div className="ml-auto flex items-center gap-1">
          {WINDOW_ACTIONS.map(({ kind, label, icon: Icon }) => (
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
          ))}
        </div>
      ) : null}
    </div>
  );
}
