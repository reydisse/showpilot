import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { UseTimecodeReturn } from "@/hooks/useTimecode";
import { MidiControllerRuntime } from "@/lib/midi-controller-runtime";
import { apcMiniMk2CueBindings, apcMiniMk2Led, bindingPadState, controllerCueView, cueBank, isContinuousAction, midiActionSchema, midiControllerSchema, midiInputKey, type MidiAction, type MidiBinding, type MidiControllerConfig, type MidiPortIdentity } from "@/lib/midi-controller";
import { cueReviewMatches, cueReviewState } from "@/lib/automation-cues";
import { framesToTimecode, timecodeToFrames } from "@/lib/timecode";
import { createBrowserId } from "@/lib/browser-id";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AutomationEvent } from "@/types/timecode";

const button = "min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text focus-visible:ring-2 disabled:opacity-40";
const field = "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text";
function identity(port: MidiPortIdentity): MidiPortIdentity { return { id: port.id, name: port.name, manufacturer: port.manufacturer }; }
function mappedCueLabel(action: MidiAction, events: AutomationEvent[]): string {
  if ("cueId" in action) return `: ${events.find(cue => cue.id === action.cueId)?.label ?? "Missing cue"}`;
  return "slot" in action ? ` ${action.slot + 1}` : "";
}
type Review = { kind: "rearm"; cue: AutomationEvent } | { kind: "reset" };

function useController(timecode: UseTimecodeReturn, showId: string | null) {
  const [runtime, setRuntime] = useState<MidiControllerRuntime | null>(null);
  const [ports, setPorts] = useState<{ inputs: MIDIInput[]; outputs: MIDIOutput[]; inputConnected: boolean; outputConnected: boolean }>({ inputs: [], outputs: [], inputConnected: false, outputConnected: false });
  const [armedSnapshot, setArmedSnapshot] = useState<{ showId: string; revision: number } | null>(null);
  const armed = showId !== null && armedSnapshot?.showId === showId && armedSnapshot.revision === timecode.controller.revision;
  const setArmed = (value: boolean) => setArmedSnapshot(value && showId ? { showId, revision: timecode.controller.revision } : null);
  const [bank, setBank] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [learning, setLearning] = useState<MidiAction | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const learn = useRef<((binding: MidiBinding) => void) | null>(null);
  const epoch = useRef(0);
  const continuous = useRef<{ timer: ReturnType<typeof setTimeout> | null; values: Map<string, number>; remainder: Map<string, number>; pending: Map<string, { binding: MidiBinding; value: number }> }>({ timer: null, values: new Map(), remainder: new Map(), pending: new Map() });
  const latest = useRef({ timecode, armed, bank, review, learning });
  latest.current = { timecode, armed, bank, review, learning };
  const clearContinuous = useCallback(() => {
    if (continuous.current.timer !== null) clearTimeout(continuous.current.timer);
    continuous.current = { timer: null, pending: new Map(), values: new Map(), remainder: new Map() };
  }, []);
  const setFrame = (frame: number) => {
    const tc = latest.current.timecode;
    if (!tc.state) return;
    if (tc.state.source !== "internal-freerun") { setError("Locate external timecode at its source. Controller seeking is available for the internal clock."); return; }
    const maximum = timecodeToFrames({ hours: 23, minutes: 59, seconds: 59, frames: Math.round(tc.state.format.frameRate) - 1 }, tc.state.format);
    tc.setTimecode(framesToTimecode(Math.max(0, Math.min(maximum, Math.round(frame))), tc.state.format));
  };
  const perform = (action: MidiAction) => {
    const { timecode: tc, bank: page, review: pendingReview } = latest.current;
    if (!tc.state || !tc.connected || tc.control !== "yours") return;
    if (pendingReview && action.kind !== "stop") { setError("Finish or cancel the controller confirmation first."); return; }
    setError(null);
    const cue = "cueId" in action ? tc.events.find(cue => cue.id === action.cueId) : action.kind === "cue-slot" ? cueBank(tc.events, page)[action.slot] : null;
    if (("cueId" in action || action.kind === "cue-slot") && !cue) { setError("This mapping has no cue in the selected bank. Review the timeline or choose another bank."); return; }
    switch (action.kind) {
      case "start":
        if (tc.generatorPending || tc.state.running) return;
        if (tc.state.source !== "internal-freerun" && !tc.isMaster) { setError("Start the external source in Timecode Source before controlling it here."); return; }
        tc.startFreerun(); break;
      case "stop":
        if (tc.state.source !== "internal-freerun" && !tc.isMaster) { setError("Stop the external source at its controller. This browser does not own that source."); return; }
        tc.stopGenerator(); break;
      case "pause": tc.pauseGenerator(); break;
      case "reset": setReview({ kind: "reset" }); break;
      case "seek": setFrame(action.frame); break;
      case "fire-next": tc.fireNext(); break;
      case "fire": case "cue-slot": if (cue) tc.fireEvent(cue.id); break;
      case "skip": if (cue) tc.skipEvent(cue.id); break;
      case "rearm": if (cue) setReview({ kind: "rearm", cue: { ...cue } }); break;
      case "bank-next": setBank(Math.min(Math.max(0, Math.ceil(tc.events.length / 64) - 1), page + 1)); break;
      case "bank-prev": setBank(Math.max(0, page - 1)); break;
      case "scrub": case "offset": case "jog": break;
      default: { const exhaustive: never = action; return exhaustive; }
    }
  };
  const onMessage = useRef<(input: MidiBinding["input"], value: number, previous: number | undefined) => void>(() => {});
  onMessage.current = (input, value, previous) => {
    const current = latest.current;
    if (current.learning) {
      const action = current.learning;
      if (input.kind === "note" && value === 0) return;
      if (isContinuousAction(current.learning) && input.kind !== "cc") { setError("Move a fader for this action."); return; }
      const capture = learn.current; learn.current = null;
      latest.current.learning = null; setLearning(null);
      capture?.({ id: createBrowserId(), input, action });
      return;
    }
    if (!current.armed || !current.timecode.connected || current.timecode.control !== "yours") return;
    const binding = current.timecode.controller.config.bindings.find(binding => midiInputKey(binding.input) === midiInputKey(input));
    if (!binding) return;
    if (!isContinuousAction(binding.action)) {
      if (input.kind === "note" ? value > 0 && !previous : value >= 64 && (previous === undefined || previous < 64)) perform(binding.action);
      return;
    }
    continuous.current.pending.set(midiInputKey(input), { binding, value });
    if (continuous.current.timer !== null) return;
    continuous.current.timer = setTimeout(() => {
      continuous.current.timer = null;
      const pendingInputs = [...continuous.current.pending.values()]; continuous.current.pending.clear();
      const current = latest.current;
      if (!current.armed || !current.timecode.connected || current.timecode.control !== "yours" || current.review || !current.timecode.state) return;
      for (const pending of pendingInputs) {
        const action = pending.binding.action;
        if (!isContinuousAction(action)) continue;
        const key = midiInputKey(pending.binding.input);
        const prior = continuous.current.values.get(key);
        continuous.current.values.set(key, pending.value);
        if (action.kind === "scrub") setFrame(pending.value * action.frames / 127);
        else if (prior !== undefined) {
          if (current.timecode.state.source !== "internal-freerun") { setError("Locate external timecode at its source. Faders control the internal clock."); return; }
          const delta = (pending.value - prior) * (action.kind === "offset" ? action.frames * 2 / 127 : action.frames) + (continuous.current.remainder.get(key) ?? 0);
          const frames = Math.round(delta);
          continuous.current.remainder.set(key, delta - frames);
          if (frames) current.timecode.adjustTimecode(frames);
        }
      }
    }, 50);
  };
  const connect = async () => {
    if (connecting || runtime) return;
    const request = ++epoch.current; setConnecting(true); setError(null);
    try {
      if (!navigator.requestMIDIAccess) throw new Error("MIDI controllers are unavailable in this browser. Use a Web MIDI capable browser.");
      const access = await navigator.requestMIDIAccess();
      if (request !== epoch.current) return;
      setRuntime(new MidiControllerRuntime(access, {
        message: (...args) => onMessage.current(...args), error: setError,
        ports: (inputs, outputs, inputConnected, outputConnected) => {
          clearContinuous();
          setPorts({ inputs, outputs, inputConnected, outputConnected });
        },
      }));
    } catch (cause) { if (request === epoch.current) setError(cause instanceof Error ? cause.message : "Could not open MIDI controller."); }
    finally { if (request === epoch.current) setConnecting(false); }
  };
  useEffect(() => () => { ++epoch.current; }, []);
  useEffect(() => { setArmedSnapshot(null); setBank(0); setReview(null); setLearning(null); learn.current = null; clearContinuous(); }, [showId, clearContinuous]);
  useEffect(() => () => { runtime?.stop(); clearContinuous(); }, [runtime, clearContinuous]);
  useEffect(() => {
    runtime?.select(timecode.controller.config.input, timecode.controller.config.output);
    setArmed(false); setReview(null); clearContinuous();
  }, [runtime, timecode.controller, clearContinuous]);
  useEffect(() => { if (!timecode.connected || timecode.control !== "yours") { setArmed(false); setReview(null); clearContinuous(); } }, [timecode.connected, timecode.control, clearContinuous]);
  useEffect(() => { setBank(page => Math.min(page, Math.max(0, Math.ceil(timecode.events.length / 64) - 1))); }, [timecode.events.length]);
  useEffect(() => {
    if (!runtime || !timecode.state) return;
    const clock = timecode.state;
    const view = controllerCueView(timecode.events, clock.totalFrames, bank);
    const messages = armed && timecode.connected && timecode.control === "yours" && timecode.controller.config.feedback === "apc-mini-mk2" ? timecode.controller.config.bindings.flatMap(binding => {
      if (binding.input.kind !== "note") return [];
      const message = apcMiniMk2Led(binding.input.number, bindingPadState(binding, timecode.events, clock, bank, view));
      return message ? [message] : [];
    }) : [];
    runtime.feedback(messages);
  }, [runtime, timecode.controller, timecode.state, timecode.events, timecode.connected, timecode.control, armed, bank]);
  return { ...ports, armed, bank, error, connecting, learning, review, ready: runtime !== null,
    connect, perform, setError,
    disarm: () => { latest.current.armed = false; setArmed(false); clearContinuous(); },
    arm: () => { if (ports.inputConnected && timecode.connected && timecode.control === "yours") { runtime?.resetInput(); clearContinuous(); setArmed(true); } },
    beginLearn: (action: MidiAction, capture: (binding: MidiBinding) => void) => {
      latest.current.armed = false; setArmed(false); clearContinuous(); learn.current = capture; setLearning(action); setError(null);
    },
    cancelLearn: () => { learn.current = null; setLearning(null); },
    closeReview: () => setReview(null),
    confirm: () => {
      if (review?.kind === "reset") { if (!timecode.state?.running) setFrame(0); }
      else if (review) timecode.rearmEvent(review.cue.id, cueReviewState(review.cue));
      setReview(null);
    },
  };
}
const ControllerContext = createContext<ReturnType<typeof useController> | null>(null);
function useMidiController() {
  const value = useContext(ControllerContext);
  if (!value) throw new Error("MIDI controller requires its show provider.");
  return value;
}
export function MidiControllerProvider({ timecode, showId, children }: { timecode: UseTimecodeReturn; showId: string | null; children: ReactNode }) {
  const controller = useController(timecode, showId);
  const review = controller.review;
  const event = review?.kind === "rearm" ? timecode.events.find(event => event.id === review.cue.id) : null;
  const changed = review?.kind === "rearm" && (!event || event.executionStatus === "dispatching" || !cueReviewMatches(event, cueReviewState(review.cue)));
  return <ControllerContext.Provider value={controller}>{children}
    {controller.armed && <aside aria-label="MIDI controller status" className="fixed bottom-3 right-3 z-40 max-w-[calc(100vw-1.5rem)] rounded-xl border border-board-border bg-board-card p-3 shadow-lg">
      <div className="flex flex-wrap items-center gap-3 text-sm text-board-text"><span>MIDI armed · Bank {controller.bank + 1}{!controller.inputConnected ? " · Input disconnected" : ""}</span><button className={button} onClick={controller.disarm}>Disarm MIDI</button></div>
      {(controller.error || timecode.lastError) && <p role="alert" className="mt-2 max-w-md text-sm text-red-300">{controller.error || timecode.lastError}</p>}
    </aside>}
    <ConfirmDialog open={Boolean(review)} onOpenChange={open => { if (!open) controller.closeReview(); }}
      title={review?.kind === "reset" ? "Reset the clock to zero?" : "Re-arm the mapped cue?"}
      description={review?.kind === "reset" ? "Pause or stop the clock first. This resets its position and preserves already-fired cues. Large seeks hold automation for review." : changed ? "The cue changed. Cancel and review its latest status." : `Re-arm ${review?.cue.label ?? "this cue"} without firing it now? Check the output before repeating an action.`}
      confirmLabel={review?.kind === "reset" ? "Reset clock" : "Re-arm cue"}
      confirmDisabled={!timecode.connected || timecode.control !== "yours" || Boolean(changed) || review?.kind === "reset" && Boolean(timecode.state?.running)} onConfirm={controller.confirm} />
  </ControllerContext.Provider>;
}

export function MidiControllerPanel({ timecode }: { timecode: UseTimecodeReturn }) {
  const controller = useMidiController();
  const saved = timecode.controller;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [kind, setKind] = useState<MidiAction["kind"]>("fire-next");
  const [cueId, setCueId] = useState("");
  const [value, setValue] = useState(30);
  const dirty = JSON.stringify(draft.config) !== JSON.stringify(saved.config);
  const canEdit = timecode.connected && timecode.control === "yours" && !controller.armed;
  useEffect(() => {
    if (!saving) return;
    if (saved.revision > draft.revision) {
      setSaving(false);
      if (JSON.stringify(saved.config) === JSON.stringify(draft.config)) { setDraft(saved); setSaveError(null); }
      else setSaveError("Mappings changed while saving. Reload the saved mappings before trying again.");
      return;
    }
    const timer = setTimeout(() => { setSaving(false); setSaveError("Save was not confirmed. Your mappings are kept here; reconnect and review before retrying."); }, 5000);
    return () => clearTimeout(timer);
  }, [saving, saved, draft]);
  // Hydration may arrive after the panel mounted. Do not overwrite actual edits.
  useEffect(() => { if (draft.revision === 0 && draft.config.bindings.length === 0 && draft.config.input === null && !saving) setDraft(saved); }, [saved, draft, saving]);
  const edit = (config: MidiControllerConfig) => { setDraft(current => ({ ...current, config })); setSaveError(null); };
  const action = (): MidiAction => {
    switch (kind) {
      case "fire": case "skip": case "rearm": return { kind, cueId };
      case "seek": return { kind, frame: value };
      case "cue-slot": return { kind, slot: value };
      case "scrub": case "offset": case "jog": return { kind, frames: value };
      default: return { kind };
    }
  };
  const selectPort = (ports: MidiPortIdentity[], selected: string): MidiPortIdentity | null => {
    const port = ports.find(port => port.id === selected); return port ? identity(port) : null;
  };
  const options: { kind: MidiAction["kind"]; label: string }[] = [
    { kind: "fire-next", label: "Fire next cue" }, { kind: "fire", label: "Fire one cue" }, { kind: "skip", label: "Skip cue" }, { kind: "rearm", label: "Re-arm cue with confirmation" },
    { kind: "start", label: "Start / resume clock" }, { kind: "stop", label: "Stop clock" }, { kind: "pause", label: "Pause clock" }, { kind: "reset", label: "Reset clock with confirmation" }, { kind: "seek", label: "Set timecode position" },
    { kind: "bank-next", label: "Next cue bank" }, { kind: "bank-prev", label: "Previous cue bank" }, { kind: "scrub", label: "Fader: scrub" }, { kind: "offset", label: "Fader: offset trim" }, { kind: "jog", label: "Fader: jog" },
  ];
  return <section aria-label="MIDI controller" className="min-w-0 space-y-4 rounded-xl border border-board-border bg-board-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-board-text">MIDI controller</h3>
      <button type="button" className={button} disabled={controller.connecting || controller.ready} onClick={() => void controller.connect()}>{controller.connecting ? "Opening MIDI…" : controller.ready ? "MIDI available" : "Connect controller"}</button></div>
    <p role="status" className="text-sm text-board-muted">{controller.armed ? "Controller armed for this show." : "Controller disarmed. Saved mappings do not activate automatically."} {controller.ready && (controller.inputConnected ? "Input connected." : "Selected input disconnected.")} {saved.config.output && (controller.outputConnected ? "Feedback connected." : "Feedback output disconnected.")}</p>
    {(controller.error || saveError) && <p role="alert" className="text-sm text-red-300">{saveError || controller.error}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0 space-y-1 text-sm text-board-muted">Controller input<select aria-label="Controller input" className={field} disabled={!canEdit || saving} value={draft.config.input?.id ?? ""} onChange={event => edit({ ...draft.config, input: selectPort(controller.inputs, event.target.value) })}><option value="">Choose an input</option>{draft.config.input && !controller.inputs.some(port => port.id === draft.config.input?.id) && <option value={draft.config.input.id}>{draft.config.input.name} (saved)</option>}{controller.inputs.map(port => <option key={port.id} value={port.id}>{port.name || port.id}</option>)}</select></label>
      <label className="min-w-0 space-y-1 text-sm text-board-muted">Feedback output<select aria-label="Controller output" className={field} disabled={!canEdit || saving} value={draft.config.output?.id ?? ""} onChange={event => edit({ ...draft.config, output: selectPort(controller.outputs, event.target.value) })}><option value="">No output</option>{draft.config.output && !controller.outputs.some(port => port.id === draft.config.output?.id) && <option value={draft.config.output.id}>{draft.config.output.name} (saved)</option>}{controller.outputs.map(port => <option key={port.id} value={port.id}>{port.name || port.id}</option>)}</select></label>
    </div>
    <label className="block text-sm text-board-muted">Pad feedback<select aria-label="Pad feedback" className={field} disabled={!canEdit || saving} value={draft.config.feedback} onChange={event => edit({ ...draft.config, feedback: event.target.value === "apc-mini-mk2" ? "apc-mini-mk2" : "none" })}><option value="none">None / generic controller</option><option value="apc-mini-mk2">APC mini mk2</option></select></label>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={!canEdit || saving} onClick={() => edit({ ...draft.config, feedback: "apc-mini-mk2", bindings: [...apcMiniMk2CueBindings(), ...draft.config.bindings.filter(binding => binding.input.kind !== "note" || binding.input.channel !== 0 || binding.input.number >= 64)] })}>Map APC cue grid</button>
      <button className={button} disabled={!canEdit || saving || !dirty} onClick={() => {
        const parsed = midiControllerSchema.safeParse(draft.config);
        if (!parsed.success) { setSaveError(parsed.error.issues[0]?.message ?? "Invalid mappings."); return; }
        const result = timecode.saveController(parsed.data, draft.revision);
        if (result.status === "failed") setSaveError(result.error); else { setSaving(true); setSaveError(null); }
      }}>{saving ? "Saving mappings…" : "Save mappings"}</button>
      <button className={button} disabled={saving || controller.armed} onClick={() => { setDraft(saved); setSaveError(null); controller.cancelLearn(); }}>Reload saved mappings</button>
      <button className={button} disabled={!controller.armed && (!controller.inputConnected || Boolean(controller.learning) || dirty || saving || timecode.control !== "yours" || !timecode.connected)} onClick={controller.armed ? controller.disarm : controller.arm}>{controller.armed ? "Disarm controller" : "Arm controller"}</button>
    </div>
    <p className="text-xs text-board-muted">Save the input first, then learn controls. MIDI learning never runs an action. Start resumes a paused local source or starts the internal clock. Seeking and faders control the internal clock; large jumps hold automation for review.</p>
    <fieldset disabled={!canEdit || saving || !controller.inputConnected || dirty} className="min-w-0 space-y-2">
      <legend className="text-sm text-board-text">Learn a pad or fader</legend>
      <select aria-label="Controller action" className={field} value={kind} onChange={event => { const selected = options.find(option => option.kind === event.target.value); if (selected) setKind(selected.kind); }}>{options.map(option => <option key={option.kind} value={option.kind}>{option.label}</option>)}</select>
      {(["fire", "skip", "rearm"].includes(kind)) && <select aria-label="Mapped cue" className={field} value={cueId} onChange={event => setCueId(event.target.value)}><option value="">Choose a cue</option>{timecode.events.map(cue => <option key={cue.id} value={cue.id}>{cue.label}</option>)}</select>}
      {(["seek", "scrub", "offset", "jog"].includes(kind)) && <label className="block text-sm text-board-muted">{kind === "seek" ? "Position in frames" : kind === "jog" ? "Frames per fader step" : kind === "offset" ? "Trim range in frames" : "Scrub end in frames"}<input className={field} type="number" min="0" value={value} onChange={event => setValue(event.target.valueAsNumber)} /></label>}
      <button className={button} onClick={() => {
        const chosen = midiActionSchema.safeParse(action());
        if (!chosen.success) { controller.setError("Choose a cue and valid frame values before learning this action."); return; }
        controller.beginLearn(chosen.data, binding => {
          setDraft(current => ({ ...current, config: { ...current.config, bindings: [...current.config.bindings.filter(existing => midiInputKey(existing.input) !== midiInputKey(binding.input)), binding] } }));
        });
      }}>Learn MIDI input</button>
    </fieldset>
    {controller.learning && <p role="status" className="text-sm text-amber-200">Press the pad or move the fader now. <button className={button} onClick={controller.cancelLearn}>Cancel learn</button></p>}
    <ul aria-label="Saved controller mappings" className="max-h-64 space-y-2 overflow-y-auto">
      {draft.config.bindings.map(binding => <li key={binding.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-board-muted"><span>{binding.input.kind.toUpperCase()} {binding.input.number} · channel {binding.input.channel + 1} → {binding.action.kind}{mappedCueLabel(binding.action, timecode.events)}</span><button className={button} aria-label={`Remove mapping ${binding.input.kind} ${binding.input.number}`} disabled={!canEdit || saving} onClick={() => edit({ ...draft.config, bindings: draft.config.bindings.filter(existing => existing.id !== binding.id) })}>Remove</button></li>)}
    </ul>
    <div className="flex flex-wrap items-center gap-2 text-sm text-board-text"><button className={button} disabled={!timecode.connected || controller.bank === 0} onClick={() => controller.perform({ kind: "bank-prev" })}>Previous bank</button><span>Bank {controller.bank + 1} of {Math.max(1, Math.ceil(timecode.events.length / 64))}</span><button className={button} disabled={!timecode.connected || (controller.bank + 1) * 64 >= timecode.events.length} onClick={() => controller.perform({ kind: "bank-next" })}>Next bank</button></div>
    <p className="text-xs text-board-muted">APC mini mk2: blue armed, yellow next, green fired, white running, red failed. Pads 0–63 follow the selected bank in timecode order. Offset and jog pick up from the first fader position after arming.</p>
    <ol aria-label="Current cue bank" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">{cueBank(timecode.events, controller.bank).map((cue, slot) => <li key={cue.id} className="min-w-0 rounded border border-board-border p-2 text-xs text-board-muted"><span className="block truncate">{slot + 1}. {cue.label}</span><span>{cue.skipped ? "Skipped" : cue.fired ? "Fired" : !cue.enabled ? "Disabled" : cue.executionStatus ?? "Armed"}</span></li>)}</ol>
  </section>;
}
