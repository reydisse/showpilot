import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Clock3, ExternalLink, MonitorOff, MonitorUp, Play, RadioTower, Wifi, WifiOff } from "lucide-react";
import { useLiveInputHealth } from "@/hooks/useLiveInputHealth";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { getTmControlState, runTmControl, type TmControlAction, type TmControlState } from "@/lib/tm-operations";
import { TmRundownControls } from "./TmRundownControls";

type Input = { id: string; name: string; status: string };
type Destination = { id: string; name: string; platform: string; enabled: boolean; connected: boolean };
type ControlState = Partial<TmControlState>;

export function TmOperations(props: { orgId: string; userId: string; slug: string; inputs: Input[]; destinations: Destination[] }) {
  const configuredOutputs = props.destinations.filter((destination) => destination.enabled).length;
  const compactSignalPath = props.inputs.length + configuredOutputs <= 2;
  return (
    <div
      className={
        compactSignalPath
          ? "space-y-4"
          : "grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(360px,.75fr)_minmax(520px,1.25fr)]"
      }
    >
      <StreamHealthPanel {...props} compact={compactSignalPath} />
      <div className="min-w-0 space-y-4"><TmRundownControls key={`${props.orgId}:${props.userId}`} orgId={props.orgId} userId={props.userId} slug={props.slug} /><ControlPad orgId={props.orgId} wide={compactSignalPath} /></div>
    </div>
  );
}

export function StreamHealthPanel({ orgId, slug, inputs, destinations, compact }: { orgId: string; slug: string; inputs: Input[]; destinations: Destination[]; compact: boolean }) {
  const health = useLiveInputHealth(orgId, inputs);
  const status = (id: string) => health.error ? "unknown" : health.value[id]?.status ?? "unknown";
  const live = inputs.filter(input => status(input.id) === "streaming").length;
  const enabled = destinations.filter(destination => destination.enabled);
  const connected = enabled.filter(destination => destination.connected).length;
  const healthy = live > 0 && !health.failure;
  const hasRows = inputs.length > 0 || enabled.length > 0;
  const telemetryTime = health.confirmedAt ? new Date(health.confirmedAt).toLocaleTimeString() : "No confirmed check";
  const telemetry = !inputs.length ? "No inputs" : health.failure ? "Unknown" : health.confirmedAt ? "Checked" : health.refreshing ? "Checking" : "Unknown";
  return <section className={`overflow-hidden rounded-xl border border-board-border bg-board-card ${compact ? "lg:grid lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]" : ""}`}>
    <header className={`flex items-center gap-3 px-4 py-3 ${compact ? "border-b border-board-border lg:border-b-0 lg:border-r" : "border-b border-board-border"}`}><span className={`w-9 h-9 rounded-lg flex items-center justify-center ${healthy ? "bg-green-500/10 text-green-400" : "bg-yellow-400/10 text-yellow-300"}`}><Activity className="w-4 h-4" /></span><div><h2 className="text-xs font-semibold text-board-text">Live stream</h2><p className="text-[11px] text-board-muted mt-0.5">{compact && !hasRows ? "No inputs or destinations configured" : "Input health and saved destination configuration"}</p></div><Link to={`/${slug}/streaming/health` as never} className="ml-auto min-h-11 inline-flex items-center gap-1 text-[11px] text-board-muted hover:text-board-text">Diagnostics <ExternalLink className="w-3 h-3" /></Link></header>
    <div>
      <div className={`grid grid-cols-1 sm:grid-cols-3 ${hasRows ? "border-b border-board-border" : ""}`}><HealthMetric label="Inputs live" value={`${live}/${inputs.length}`} good={live > 0} /><HealthMetric label="Configured outputs" value={`${connected}/${enabled.length}`} good={enabled.length === 0 || connected === enabled.length} /><HealthMetric label="Input check" value={telemetry} good={!!health.confirmedAt && !health.failure} detail={telemetryTime} /></div>
      <ReadFailureNotice error={health.failure} refreshing={health.refreshing} retry={health.retry} label="Retry input health" />
      {hasRows ? <div className="divide-y divide-board-border/60">{inputs.map((input) => <HealthRow key={input.id} name={input.name} detail="Live input" status={status(input.id)} />)}{enabled.map((destination) => <HealthRow key={destination.id} name={destination.name} detail={destination.platform} status={destination.connected ? "configured" : "not configured"} />)}</div> : null}
    </div>
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
  { action: "lower-third-clear", label: "Clear lower third", detail: "Clear active graphic", icon: MonitorUp },
  { action: "displays-blank", label: "Blank displays", detail: "Confirmation required", icon: MonitorOff, dangerous: true, active: (s) => Boolean(s.kioskBlanked) },
  { action: "displays-restore", label: "Restore displays", detail: "Return output", icon: MonitorUp, active: (s) => s.kioskBlanked === false },
  { action: "stream-live", label: "Go live", detail: "Connect destinations", icon: Wifi, dangerous: true, active: (s) => (s.stream?.connected ?? 0) > 0 },
  { action: "stream-stop", label: "Stop stream", detail: "Confirmation required", icon: WifiOff, dangerous: true },
];

function ControlPad({ orgId, wide }: { orgId: string; wide: boolean }) {
  const [state, setState] = useState<ControlState>({});
  const [busy, setBusy] = useState<TmControlAction | null>(null);
  const [armed, setArmed] = useState<TmControlAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const refresh = useCallback(async () => {
    if (document.visibilityState !== "visible" || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try { setState(await getTmControlState({ data: { orgId } })); } catch { setMessage("Control feedback is unavailable"); }
    finally { refreshInFlightRef.current = false; }
  }, [orgId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(null), 4_000); return () => window.clearTimeout(timer); }, [armed]);
  const run = async (control: (typeof CONTROLS)[number]) => {
    if (control.dangerous && armed !== control.action) { setArmed(control.action); setMessage("Press again within four seconds to confirm"); return; }
    setArmed(null); setBusy(control.action); setMessage(null);
    try { await runTmControl({ data: { orgId, action: control.action } }); await refresh(); setMessage(`${control.label} completed`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Control failed"); }
    finally { setBusy(null); }
  };
  return <section className="rounded-xl border border-board-border bg-board-card overflow-hidden">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-board-border"><span className="w-9 h-9 rounded-lg bg-fire-500/10 text-fire-400 flex items-center justify-center"><RadioTower className="w-4 h-4" /></span><div className="min-w-0"><h2 className="text-xs font-semibold text-board-text">Display and stream controls</h2><p className="text-[11px] text-board-muted truncate">Display and streaming outputs</p></div></header>
    <div className={`grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 ${wide ? "lg:grid-cols-5 xl:grid-cols-7" : "2xl:grid-cols-4"}`}>{CONTROLS.map((control) => { const Icon = control.icon; const isActive = control.active?.(state); const isArmed = armed === control.action; return <button key={control.action} type="button" disabled={busy !== null} onClick={() => void run(control)} className={`min-h-[72px] text-left rounded-lg border p-3 transition-colors disabled:opacity-50 ${isArmed ? "border-red-500 bg-red-500/15 text-red-300" : isActive ? "border-green-500/40 bg-green-500/10 text-green-300" : "border-board-border bg-board-bg/40 text-board-text hover:border-fire-500/35 hover:bg-board-bg"}`}><span className="flex items-center justify-between"><Icon className="w-4 h-4" />{isActive ? <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> : null}</span><span className="block text-[11px] font-medium mt-2">{isArmed ? `Confirm ${control.label}` : control.label}</span><span className="block text-[9px] text-board-muted mt-0.5">{control.detail}</span></button>; })}</div>
    <div aria-live="polite" className="min-h-8 flex items-center gap-2 px-4 py-2 border-t border-board-border text-[10px] text-board-muted"><Clock3 className="w-3 h-3" />{busy ? "Sending command…" : message ?? "Choose an output control"}</div>
  </section>;
}
