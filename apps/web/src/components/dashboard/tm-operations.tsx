import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Captions, ChevronLeft, ChevronRight, CircleStop, Clock3, ExternalLink, MonitorOff, MonitorUp, Play, RadioTower, RotateCcw, TimerReset, Wifi, WifiOff } from "lucide-react";
import { getLiveInputStatus } from "@/lib/stream";
import { getTmControlState, runTmControl, type TmControlAction } from "@/lib/tm-operations";

type Input = { id: string; name: string; status: string };
type Destination = { id: string; name: string; platform: string; enabled: boolean; connected: boolean };
type ControlState = {
  timer?: { playback?: string; elapsed?: number };
  currentItem?: { title?: string } | null;
  nextItem?: { title?: string } | null;
  lyricsEnabled?: boolean;
  kioskBlanked?: boolean;
  stream?: { connected?: number; total?: number };
};

export function TmOperations(props: { orgId: string; slug: string; inputs: Input[]; destinations: Destination[] }) {
  return <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,.95fr)] gap-4"><StreamHealthPanel {...props} /><ControlPad orgId={props.orgId} /></div>;
}

function StreamHealthPanel({ orgId, slug, inputs, destinations }: { orgId: string; slug: string; inputs: Input[]; destinations: Destination[] }) {
  const [statuses, setStatuses] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((item) => [item.id, item.status])));
  const [updatedAt, setUpdatedAt] = useState(Date.now());
  useEffect(() => {
    if (!inputs.length) return;
    let active = true;
    const poll = async () => {
      const results = await Promise.all(inputs.map(async (input) => {
        try { return [input.id, (await getLiveInputStatus({ data: { orgId, inputId: input.id } }))?.status ?? input.status] as const; }
        catch { return [input.id, input.status] as const; }
      }));
      if (active) { setStatuses(Object.fromEntries(results)); setUpdatedAt(Date.now()); }
    };
    void poll();
    const timer = window.setInterval(poll, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [inputs, orgId]);
  const live = inputs.filter((input) => statuses[input.id] === "streaming").length;
  const enabled = destinations.filter((destination) => destination.enabled);
  const connected = enabled.filter((destination) => destination.connected).length;
  const healthy = inputs.length > 0 && live > 0 && (enabled.length === 0 || connected === enabled.length);
  return <section className="rounded-xl border border-board-border bg-board-card overflow-hidden">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-board-border"><span className={`w-9 h-9 rounded-lg flex items-center justify-center ${healthy ? "bg-green-500/10 text-green-400" : "bg-yellow-400/10 text-yellow-300"}`}><Activity className="w-4 h-4" /></span><div><h2 className="text-xs font-semibold text-board-text">Live stream</h2><p className="text-[11px] text-board-muted mt-0.5">Inputs and delivery · refreshes every 10 seconds</p></div><Link to={`/${slug}/streaming/health` as never} className="ml-auto inline-flex items-center gap-1 text-[11px] text-board-muted hover:text-board-text">Diagnostics <ExternalLink className="w-3 h-3" /></Link></header>
    <div className="grid grid-cols-3 border-b border-board-border"><HealthMetric label="Inputs live" value={`${live}/${inputs.length}`} good={live > 0} /><HealthMetric label="Destinations" value={`${connected}/${enabled.length}`} good={enabled.length === 0 || connected === enabled.length} /><HealthMetric label="Telemetry" value="Online" good detail={new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} /></div>
    <div className="divide-y divide-board-border/60">{inputs.length ? inputs.map((input) => <HealthRow key={input.id} name={input.name} detail="Live input" status={statuses[input.id] ?? input.status} />) : <p className="px-4 py-4 text-xs text-board-muted">No live input configured.</p>}{enabled.map((destination) => <HealthRow key={destination.id} name={destination.name} detail={destination.platform} status={destination.connected ? "connected" : "idle"} />)}</div>
  </section>;
}

function HealthMetric({ label, value, good, detail }: { label: string; value: string; good: boolean; detail?: string }) {
  return <div className="px-4 py-3 border-r last:border-r-0 border-board-border"><p className="text-[10px] text-board-muted uppercase tracking-wider">{label}</p><p className={`text-lg font-semibold tabular-nums mt-0.5 ${good ? "text-green-400" : "text-yellow-300"}`}>{value}</p>{detail ? <p className="text-[9px] text-board-muted truncate">{detail}</p> : null}</div>;
}
function HealthRow({ name, detail, status }: { name: string; detail: string; status: string }) {
  const online = status === "streaming" || status === "connected";
  return <div className="flex items-center gap-3 px-4 py-2.5"><span className={`w-2 h-2 rounded-full ${online ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,.5)]" : "bg-board-muted"}`} /><div className="min-w-0 flex-1"><p className="text-xs text-board-text truncate">{name}</p><p className="text-[10px] text-board-muted">{detail}</p></div><span className={`text-[10px] uppercase tracking-wider ${online ? "text-green-400" : "text-board-muted"}`}>{status}</span></div>;
}

const CONTROLS: Array<{ action: TmControlAction; label: string; detail: string; icon: typeof Play; dangerous?: boolean; active?: (state: ControlState) => boolean }> = [
  { action: "timer-start", label: "Start timer", detail: "Resume current item", icon: Play, active: (s) => s.timer?.playback === "play" },
  { action: "timer-stop", label: "Stop timer", detail: "Stop transport", icon: CircleStop },
  { action: "rundown-previous", label: "Previous", detail: "Previous rundown item", icon: ChevronLeft },
  { action: "rundown-next", label: "Next", detail: "Advance rundown item", icon: ChevronRight },
  { action: "timer-subtract", label: "−1 minute", detail: "Adjust timer", icon: RotateCcw },
  { action: "timer-add", label: "+1 minute", detail: "Adjust timer", icon: TimerReset },
  { action: "lyrics-on", label: "Lyrics on", detail: "Enable lyrics state", icon: Captions, active: (s) => Boolean(s.lyricsEnabled) },
  { action: "lyrics-off", label: "Lyrics off", detail: "Disable lyrics state", icon: Captions, active: (s) => s.lyricsEnabled === false },
  { action: "lower-third-clear", label: "Clear lower third", detail: "Clear active graphic", icon: MonitorUp },
  { action: "displays-blank", label: "Blank displays", detail: "Confirmation required", icon: MonitorOff, dangerous: true, active: (s) => Boolean(s.kioskBlanked) },
  { action: "displays-restore", label: "Restore displays", detail: "Return output", icon: MonitorUp, active: (s) => s.kioskBlanked === false },
  { action: "stream-live", label: "Go live", detail: "Connect destinations", icon: Wifi, dangerous: true, active: (s) => (s.stream?.connected ?? 0) > 0 },
  { action: "stream-stop", label: "Stop stream", detail: "Confirmation required", icon: WifiOff, dangerous: true },
];

function ControlPad({ orgId }: { orgId: string }) {
  const [state, setState] = useState<ControlState>({});
  const [busy, setBusy] = useState<TmControlAction | null>(null);
  const [armed, setArmed] = useState<TmControlAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => { try { setState(await getTmControlState({ data: { orgId } }) as ControlState); } catch { setMessage("Control feedback is unavailable"); } }, [orgId]);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 5_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(null), 4_000); return () => window.clearTimeout(timer); }, [armed]);
  const run = async (control: (typeof CONTROLS)[number]) => {
    if (control.dangerous && armed !== control.action) { setArmed(control.action); setMessage("Press again within four seconds to confirm"); return; }
    setArmed(null); setBusy(control.action); setMessage(null);
    try { await runTmControl({ data: { orgId, action: control.action } }); await refresh(); setMessage(`${control.label} completed`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Control failed"); }
    finally { setBusy(null); }
  };
  const elapsed = useMemo(() => formatElapsed(state.timer?.elapsed ?? 0), [state.timer?.elapsed]);
  return <section className="rounded-xl border border-board-border bg-board-card overflow-hidden">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-board-border"><span className="w-9 h-9 rounded-lg bg-fire-500/10 text-fire-400 flex items-center justify-center"><RadioTower className="w-4 h-4" /></span><div className="min-w-0"><h2 className="text-xs font-semibold text-board-text">Technical control pad</h2><p className="text-[11px] text-board-muted truncate">{state.currentItem?.title ?? "No active rundown item"} · {elapsed}</p></div><span className={`ml-auto text-[10px] uppercase tracking-wider ${state.timer?.playback === "play" ? "text-green-400" : "text-board-muted"}`}>{state.timer?.playback ?? "offline"}</span></header>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">{CONTROLS.map((control) => { const Icon = control.icon; const isActive = control.active?.(state); const isArmed = armed === control.action; return <button key={control.action} type="button" disabled={busy !== null} onClick={() => void run(control)} className={`min-h-[72px] text-left rounded-lg border p-3 transition-colors disabled:opacity-50 ${isArmed ? "border-red-500 bg-red-500/15 text-red-300" : isActive ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-board-border bg-board-bg/40 text-board-text hover:border-fire-500/35 hover:bg-board-bg"}`}><span className="flex items-center justify-between"><Icon className="w-4 h-4" />{isActive ? <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> : null}</span><span className="block text-[11px] font-medium mt-2">{isArmed ? `Confirm ${control.label}` : control.label}</span><span className="block text-[9px] text-board-muted mt-0.5">{control.detail}</span></button>; })}</div>
    <div aria-live="polite" className="min-h-8 flex items-center gap-2 px-4 py-2 border-t border-board-border text-[10px] text-board-muted"><Clock3 className="w-3 h-3" />{busy ? "Sending command…" : message ?? `Next: ${state.nextItem?.title ?? "—"}`}</div>
  </section>;
}

function formatElapsed(milliseconds: number) { const seconds = Math.max(0, Math.floor(milliseconds / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
