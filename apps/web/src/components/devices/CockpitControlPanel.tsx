import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleStop,
  Lightbulb,
  MonitorUp,
  Radio,
  ShieldAlert,
  SlidersHorizontal,
  Video,
  Volume2,
} from "lucide-react";
import {
  parseBooleanArrayFeedback,
  parseNumberArrayFeedback,
  parseStringArrayFeedback,
  resolveDeviceControlSurface,
} from "@/lib/device-control-surface";
import type {
  DeviceConnectionStatus,
  DeviceModule,
  ModuleAction,
  ModuleDefinition,
} from "@/lib/device-modules/types";
import { GenericControlPanel } from "./GenericControlPanel";

interface CockpitControlPanelProps {
  module: DeviceModule | null;
  status: DeviceConnectionStatus;
  feedbacks: Map<string, unknown>;
  definition: ModuleDefinition;
}

type RunCommand = (actionId: string, params?: Record<string, unknown>) => Promise<void>;

export function CockpitControlPanel({ module, status, feedbacks, definition }: CockpitControlPanelProps) {
  const actions = useMemo(
    () => module?.getActions() ?? definition.remoteControl?.actions({}) ?? [],
    [definition, module],
  );
  const surface = resolveDeviceControlSurface(actions, definition.category);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const connected = status === "connected";
  const run = useCallback<RunCommand>(async (actionId, params = {}) => {
    if (!module || !connected || pendingAction) return;
    setPendingAction(actionId);
    setCommandError(null);
    try {
      await module.executeAction(actionId, params);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "The device command failed.");
    } finally {
      setPendingAction(null);
    }
  }, [connected, module, pendingAction]);

  const common = { actions, connected, feedbacks, pendingAction, run };

  return (
    <div className="space-y-3">
      {surface === "switcher" ? <SwitcherSurface {...common} /> : null}
      {surface === "mixer" ? <MixerSurface {...common} /> : null}
      {surface === "display" ? <DisplaySurface {...common} /> : null}
      {surface === "streaming" ? <StreamingSurface {...common} /> : null}
      {surface === "lighting" ? <LightingSurface {...common} /> : null}
      {surface === "automation" || surface === "generic" ? (
        <GenericControlPanel module={module} status={status} feedbacks={feedbacks} definition={definition} />
      ) : null}
      {commandError ? (
        <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs text-red-300">
          {commandError}
        </div>
      ) : null}
    </div>
  );
}

interface SurfaceProps {
  actions: ModuleAction[];
  connected: boolean;
  feedbacks: Map<string, unknown>;
  pendingAction: string | null;
  run: RunCommand;
}

function actionById(actions: ModuleAction[], id: string): ModuleAction | undefined {
  return actions.find((action) => action.id === id);
}

function SurfaceHeader({ icon: Icon, title, detail }: { icon: React.ElementType; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-board-border px-4 py-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-board-border bg-board-bg"><Icon className="h-4 w-4 text-fire-500" /></span>
      <div><h3 className="text-xs font-semibold text-board-text">{title}</h3><p className="mt-0.5 text-[10px] text-board-muted">{detail}</p></div>
    </div>
  );
}

function CommandButton({ action, connected, pendingAction, params, run, tone = "default", guarded = false, label }: {
  action: ModuleAction | undefined;
  connected: boolean;
  pendingAction: string | null;
  params?: Record<string, unknown>;
  run: RunCommand;
  tone?: "default" | "program" | "preview" | "danger" | "amber";
  guarded?: boolean;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (!action) return null;
  const tones = {
    default: "border-board-border bg-board-bg text-board-text hover:border-fire-500/35",
    program: "border-red-500/45 bg-red-500/15 text-red-200 hover:bg-red-500/25",
    preview: "border-green-500/45 bg-green-500/15 text-green-200 hover:bg-green-500/25",
    danger: "border-red-500/45 bg-red-500/[0.08] text-red-300 hover:bg-red-500/15",
    amber: "border-fire-500/45 bg-fire-500/[0.08] text-fire-400 hover:bg-fire-500/15",
  };
  const pending = pendingAction === action.id;
  return (
    <button
      type="button"
      disabled={!connected || pendingAction !== null}
      onClick={() => {
        if (guarded && !armed) { setArmed(true); return; }
        setArmed(false);
        void run(action.id, params);
      }}
      className={`min-h-11 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {pending ? "Sending…" : armed ? `Confirm ${label ?? action.label}` : label ?? action.label}
    </button>
  );
}

function SwitcherSurface(props: SurfaceProps) {
  const program = Number(props.feedbacks.get("program_input") ?? props.feedbacks.get("active_input") ?? 0);
  const preview = Number(props.feedbacks.get("preview_input") ?? 0);
  const transition = Number(props.feedbacks.get("transition_position") ?? 0);
  const programAction = actionById(props.actions, "set_program_input");
  const previewAction = actionById(props.actions, "set_preview_input");
  const inputCount = Math.min(20, Number(programAction?.params.find((param) => param.id === "input")?.max ?? 8));
  const inputs = Array.from({ length: inputCount }, (_, index) => index + 1);
  return (
    <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
      <SurfaceHeader icon={Video} title="Switcher" detail="Program, preview, transitions, keyers and macros" />
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_180px]">
        <div className="space-y-4">
          <SourceRow label="PROGRAM" tone="program" selected={program} inputs={inputs} action={programAction} {...props} />
          <SourceRow label="PREVIEW" tone="preview" selected={preview} inputs={inputs} action={previewAction} {...props} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <CommandButton action={actionById(props.actions, "cut")} label="CUT" {...props} />
            <CommandButton action={actionById(props.actions, "auto_transition")} label="AUTO" tone="amber" {...props} />
            <CommandButton action={actionById(props.actions, "fade_to_black")} label="FADE TO BLACK" tone="danger" guarded {...props} />
          </div>
        </div>
        <div className="rounded-lg border border-board-border bg-board-bg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-board-muted">Transition</p>
          <div className="mt-3 h-40 overflow-hidden rounded bg-black/40 p-2">
            <div className="relative mx-auto h-full w-3 rounded-full bg-board-border"><span className="absolute inset-x-[-8px] h-3 rounded bg-board-text shadow" style={{ bottom: `${Math.max(0, Math.min(100, transition * 100))}%` }} /></div>
          </div>
          <p className="mt-2 text-center text-xs tabular-nums text-board-muted">{Math.round(transition * 100)}%</p>
        </div>
      </div>
    </section>
  );
}

function SourceRow({ label, tone, selected, inputs, action, connected, pendingAction, run }: SurfaceProps & {
  label: string;
  tone: "program" | "preview";
  selected: number;
  inputs: number[];
  action: ModuleAction | undefined;
}) {
  const inputParam = action?.params.find((param) => param.id === "input");
  return <div><p className={`mb-2 text-[10px] font-semibold tracking-wider ${tone === "program" ? "text-red-400" : "text-green-400"}`}>{label}</p><div className="grid grid-cols-4 gap-2 sm:grid-cols-8">{inputs.map((input) => <CommandButton key={input} action={action} connected={connected} pendingAction={pendingAction} run={run} params={{ input: inputParam?.type === "string" ? String(input) : input }} label={String(input)} tone={selected === input ? tone : "default"} />)}</div></div>;
}

function MixerSurface(props: SurfaceProps) {
  const faders = parseNumberArrayFeedback(props.feedbacks.get("channel_fader"));
  const mutes = parseBooleanArrayFeedback(props.feedbacks.get("channel_mute"));
  const maximumChannel = Number(actionById(props.actions, "set_channel_fader")?.params.find((param) => param.id === "channel")?.max ?? 16);
  const channels = Array.from({ length: Math.min(40, maximumChannel) }, (_, index) => index + 1);
  return (
    <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
      <SurfaceHeader icon={SlidersHorizontal} title="Audio mixer" detail="Live fader state, channel mute and console scenes" />
      <div className="flex items-center gap-2 border-b border-board-border px-4 py-2"><span className="rounded-md border border-fire-500/40 bg-fire-500/10 px-3 py-1.5 text-[10px] font-semibold text-fire-400">MAIN</span><span className="px-3 py-1.5 text-[10px] text-board-muted">STREAM</span><span className="px-3 py-1.5 text-[10px] text-board-muted">MONITORS</span><span className="ml-auto text-[10px] text-board-muted">Horizontal scroll for all channels</span></div>
      <div className="overflow-x-auto p-4"><div className="flex min-w-max gap-2">{channels.map((channel) => <MixerChannelStrip key={channel} channel={channel} level={faders[channel - 1] ?? null} muted={mutes[channel - 1] ?? null} {...props} />)}</div></div>
      <div className="flex flex-wrap gap-2 border-t border-board-border p-4"><SceneControl {...props} /><CommandButton action={actionById(props.actions, "mute_dca")} params={{ dca: 1, muted: true }} label="Mute DCA 1" tone="danger" guarded {...props} /></div>
    </section>
  );
}

function MixerChannelStrip({ channel, level, muted, actions, connected, pendingAction, run }: SurfaceProps & { channel: number; level: number | null; muted: boolean | null }) {
  const [localLevel, setLocalLevel] = useState(level ?? 0);
  useEffect(() => { if (level !== null) setLocalLevel(level); }, [level]);
  const commit = () => void run("set_channel_fader", { channel, level: localLevel });
  return (
    <div className="w-[76px] rounded-lg border border-board-border bg-board-bg p-2 text-center">
      <p className="truncate text-[10px] font-semibold text-board-text">CH {channel}</p>
      <div className="mt-2 flex h-44 items-stretch justify-center gap-2">
        <div className="relative w-2 overflow-hidden rounded-full bg-black/60"><span className="absolute inset-x-0 bottom-0 bg-green-500" style={{ height: level === null ? "0%" : `${Math.max(2, Math.min(100, level * 100))}%` }} /></div>
        <input aria-label={`Channel ${channel} fader`} type="range" min={0} max={1} step={0.01} value={localLevel} disabled={!connected || pendingAction !== null} onChange={(event) => setLocalLevel(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} className="h-44 w-5 accent-fire-500 [direction:rtl] [writing-mode:vertical-lr]" />
      </div>
      <p className="mt-1 text-[10px] tabular-nums text-board-muted">{level === null ? "—" : `${Math.round(localLevel * 100)}%`}</p>
      <CommandButton action={actionById(actions, "mute_channel")} connected={connected} pendingAction={pendingAction} run={run} params={{ channel, muted: !(muted ?? false) }} label={muted ? "UNMUTE" : "MUTE"} tone={muted ? "danger" : "default"} />
    </div>
  );
}

function SceneControl(props: SurfaceProps) {
  const [scene, setScene] = useState(1);
  const action = actionById(props.actions, "recall_scene");
  if (!action) return null;
  return <div className="flex items-center gap-2 rounded-lg border border-board-border bg-board-bg p-1.5"><label className="pl-2 text-[10px] text-board-muted">SCENE</label><input aria-label="Mixer scene number" type="number" min={1} max={100} value={scene} onChange={(event) => setScene(Number(event.target.value))} className="w-16 rounded border border-board-border bg-board-card px-2 py-1.5 text-xs text-board-text" /><CommandButton action={action} params={{ scene }} label="Recall" tone="amber" guarded {...props} /></div>;
}

function DisplaySurface(props: SurfaceProps) {
  const power = props.feedbacks.get("power_status");
  const input = String(props.feedbacks.get("current_input") ?? "—");
  const volume = Number(props.feedbacks.get("volume") ?? 0);
  const setInput = actionById(props.actions, "set_input");
  const options = setInput?.params.find((param) => param.id === "input")?.options ?? [];
  const [selectedInput, setSelectedInput] = useState(options[0]?.value ?? "");
  const [selectedVolume, setSelectedVolume] = useState(volume);
  useEffect(() => setSelectedVolume(volume), [volume]);
  const volumeParam = actionById(props.actions, "set_volume")?.params.find((param) => param.id === "level");
  return (
    <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
      <SurfaceHeader icon={MonitorUp} title="Display control" detail="Power, source routing, blanking and audio" />
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <div className="rounded-lg border border-board-border bg-board-bg p-4"><p className="text-[10px] text-board-muted">POWER</p><p className={`mt-1 text-lg font-semibold ${power === true || power === "on" ? "text-green-400" : "text-board-text"}`}>{power === undefined || power === null || power === "" ? "UNKNOWN" : typeof power === "boolean" ? power ? "ON" : "OFF" : String(power).toUpperCase()}</p><div className="mt-4 grid grid-cols-2 gap-2"><CommandButton action={actionById(props.actions, "power_on")} label="POWER ON" tone="preview" {...props} /><CommandButton action={actionById(props.actions, "power_off")} label="POWER OFF" tone="danger" guarded {...props} /></div></div>
        <div className="rounded-lg border border-board-border bg-board-bg p-4"><p className="text-[10px] text-board-muted">CURRENT INPUT</p><p className="mt-1 text-lg font-semibold text-board-text">{input}</p>{setInput ? <div className="mt-4 flex gap-2"><select value={selectedInput} onChange={(event) => setSelectedInput(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg border border-board-border bg-board-card px-3 text-xs text-board-text">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><CommandButton action={setInput} params={{ input: selectedInput }} label="Route" tone="amber" {...props} /></div> : null}</div>
        {actionById(props.actions, "set_volume") ? <div className="rounded-lg border border-board-border bg-board-bg p-4 lg:col-span-2"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs text-board-text"><Volume2 className="h-4 w-4" />Volume</span><span className="text-xs tabular-nums text-board-muted">{selectedVolume}</span></div><input aria-label="Display volume" type="range" min={volumeParam?.min ?? 0} max={volumeParam?.max ?? 100} step={volumeParam?.step ?? 1} value={selectedVolume} onChange={(event) => setSelectedVolume(Number(event.target.value))} onPointerUp={() => void props.run("set_volume", { level: selectedVolume })} className="mt-3 w-full accent-fire-500" /></div> : null}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-board-border p-4"><CommandButton action={actionById(props.actions, "shutter_close") ?? actionById(props.actions, "mute_video")} params={{ state: true }} label="BLANK" tone="danger" guarded {...props} /><CommandButton action={actionById(props.actions, "shutter_open")} label="UNBLANK" {...props} /><CommandButton action={actionById(props.actions, "mute")} label="MUTE" {...props} /><CommandButton action={actionById(props.actions, "unmute")} label="UNMUTE" {...props} /></div>
    </section>
  );
}

function StreamingSurface(props: SurfaceProps) {
  const live = props.feedbacks.get("streaming_active") === true;
  const recording = props.feedbacks.get("recording_active") === true;
  const scenes = parseStringArrayFeedback(props.feedbacks.get("scene_list"));
  return (
    <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
      <SurfaceHeader icon={Radio} title="Streaming & recording" detail="Program scenes, output state and guarded live controls" />
      <div className="grid gap-3 p-4 md:grid-cols-2"><StatusBlock icon={Radio} label="STREAM" active={live} /><StatusBlock icon={CircleStop} label="RECORD" active={recording} /></div>
      {scenes.length ? <div className="border-t border-board-border p-4"><p className="mb-2 text-[10px] font-semibold text-board-muted">SCENES</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{scenes.map((scene) => <CommandButton key={scene} action={actionById(props.actions, "set_current_program_scene")} params={{ sceneName: scene }} label={scene} tone={props.feedbacks.get("current_program_scene") === scene ? "program" : "default"} {...props} />)}</div></div> : null}
      <div className="grid grid-cols-2 gap-2 border-t border-board-border p-4 sm:grid-cols-4"><CommandButton action={actionById(props.actions, "start_streaming")} label="START STREAM" tone="preview" {...props} /><CommandButton action={actionById(props.actions, "stop_streaming")} label="STOP STREAM" tone="danger" guarded {...props} /><CommandButton action={actionById(props.actions, "start_recording")} label="START RECORD" {...props} /><CommandButton action={actionById(props.actions, "stop_recording")} label="STOP RECORD" tone="danger" guarded {...props} /></div>
    </section>
  );
}

function StatusBlock({ icon: Icon, label, active }: { icon: React.ElementType; label: string; active: boolean }) {
  return <div className="flex items-center gap-3 rounded-lg border border-board-border bg-board-bg p-4"><Icon className={`h-5 w-5 ${active ? "text-red-400" : "text-board-muted"}`} /><div><p className="text-[10px] text-board-muted">{label}</p><p className={`mt-0.5 text-sm font-semibold ${active ? "text-red-300" : "text-board-text"}`}>{active ? "LIVE" : "STOPPED"}</p></div></div>;
}

function LightingSurface(props: SurfaceProps) {
  const master = Number(props.feedbacks.get("master_level") ?? 100);
  const blackout = props.feedbacks.get("blackout_active") === true;
  const [level, setLevel] = useState(master);
  const [scene, setScene] = useState("");
  return (
    <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
      <SurfaceHeader icon={Lightbulb} title="Lighting" detail="Scenes, master intensity and guarded blackout" />
      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_220px]"><div className="rounded-lg border border-board-border bg-board-bg p-4"><div className="flex items-center justify-between"><span className="text-xs text-board-text">Master intensity</span><span className="text-sm font-semibold tabular-nums text-fire-400">{level}%</span></div><input aria-label="Lighting master intensity" type="range" min={0} max={100} value={level} onChange={(event) => setLevel(Number(event.target.value))} onPointerUp={() => void props.run("set_master", { level })} className="mt-4 w-full accent-fire-500" /><div className="mt-4 flex gap-2"><input aria-label="Lighting scene name" value={scene} onChange={(event) => setScene(event.target.value)} placeholder="Scene name" className="min-h-11 min-w-0 flex-1 rounded-lg border border-board-border bg-board-card px-3 text-xs text-board-text" /><CommandButton action={actionById(props.actions, "recall_scene")} params={{ scene }} label="Recall" tone="amber" {...props} /></div></div><div className={`rounded-lg border p-4 ${blackout ? "border-red-500/45 bg-red-500/10" : "border-board-border bg-board-bg"}`}><ShieldAlert className={blackout ? "h-5 w-5 text-red-400" : "h-5 w-5 text-board-muted"} /><p className="mt-3 text-xs font-semibold text-board-text">{blackout ? "BLACKOUT ACTIVE" : "Output live"}</p><div className="mt-3 grid gap-2"><CommandButton action={actionById(props.actions, "blackout")} label="BLACKOUT" tone="danger" guarded {...props} /><CommandButton action={actionById(props.actions, "restore")} label="RESTORE" {...props} /></div></div></div>
    </section>
  );
}
