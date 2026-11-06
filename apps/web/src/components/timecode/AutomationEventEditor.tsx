import { automationPayloadProblem } from "@/lib/automation-payload";
import { AutomationTargetPicker, type AutomationTargetOption, type LoadAutomationTargets } from "./AutomationTargetPicker";
import { DEFAULT_TIMECODE_TOLERANCE_FRAMES, MAX_TIMECODE_TOLERANCE_FRAMES } from "@/types/timecode";
import { isValidTimingMs, MAX_AUTOMATION_LEAD_MS } from "@/lib/automation-timing";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useId, useRef, useState } from "react";
import { createBrowserId } from "@/lib/browser-id";
import type { NewAutomationEvent } from "@/hooks/useTimecode";
import { Plus } from "lucide-react";
import type {
  AutomationActionType,
} from "@/types/timecode";
import { isValidTimecode, isValidTimecodeTolerance, parseTimecodeString } from "@/lib/timecode";

interface AutomationEventEditorProps {
  onAdd: (event: NewAutomationEvent) => Promise<void>;
  connected: boolean;
  loadTargets?: LoadAutomationTargets;
  format: import("@/types/timecode").TimecodeFormat;
}

const ACTION_OPTIONS: {
  value: AutomationActionType;
  label: string;
  category: string;
}[] = [
  { value: "lower-third-show", label: "Show Lower Third", category: "Lower Thirds" },
  { value: "lower-third-clear", label: "Clear Lower Third", category: "Lower Thirds" },
  { value: "rundown-advance", label: "Advance Rundown", category: "Rundown" },
  { value: "rundown-start-item", label: "Start Rundown Item", category: "Rundown" },
  { value: "rundown-goto-item", label: "Jump to Rundown Item", category: "Rundown" },
  { value: "rundown-previous", label: "Previous Rundown Item", category: "Rundown" },
  { value: "rundown-pause", label: "Pause Rundown Timer", category: "Rundown" },
  { value: "rundown-resume", label: "Resume Rundown Timer", category: "Rundown" },
  { value: "rundown-stop", label: "Stop Rundown", category: "Rundown" },
  { value: "rundown-adjust", label: "Adjust Rundown Timer", category: "Rundown" },
  { value: "stage-message", label: "Send Stage Message", category: "Stage Display" },
  { value: "stage-clear", label: "Clear Stage Message", category: "Stage Display" },
  { value: "device-action", label: "Trigger Device Action", category: "Devices" },
  { value: "lighting-scene", label: "Recall Lighting Scene", category: "Devices" },
  { value: "lighting-blackout", label: "Lighting Blackout", category: "Devices" },
  { value: "lyrics-goto", label: "Show Lyrics Section", category: "Lyrics" },
  { value: "lyrics-clear", label: "Clear Lyrics", category: "Lyrics" },
  { value: "pp-trigger-slide", label: "Trigger ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-next", label: "Next ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-previous", label: "Previous ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-prop", label: "Trigger ProPresenter Prop", category: "ProPresenter" },
  { value: "pp-clear-props", label: "Clear ProPresenter Props", category: "ProPresenter" },
  { value: "pp-trigger-clear", label: "Clear ProPresenter Slide", category: "Lyrics" },
  { value: "custom-webhook", label: "Custom Webhook", category: "Other" },
];

export function AutomationEventEditor({ onAdd, format, connected, loadTargets }: AutomationEventEditorProps) {
  const workspaceTerms = useWorkspaceTerms();
  const [tcString, setTcString] = useState("");
  const [action, setAction] = useState<AutomationActionType>("lower-third-show");
  const [label, setLabel] = useState("");
  const [payloadJson, setPayloadJson] = useState("{}");
  const [targetSelection, setTargetSelection] = useState<AutomationTargetOption | null>(null);
  const usesTargetPicker = action === "rundown-goto-item" || action === "lighting-blackout";
  const propNameId = useId();
  const targetId = useId();
  const [propName, setPropName] = useState("");
  const [propTarget, setPropTarget] = useState("");
  const structuredProPresenter = action === "pp-trigger-prop" || action === "pp-clear-props" || action === "pp-trigger-previous";
  const toleranceId = useId();
  const leadId = useId();
  const [leadText, setLeadText] = useState("0");
  const leadMs = Number(leadText);
  const leadValid = leadText.trim() !== "" && isValidTimingMs(leadMs);
  const leadError = `Cue lead must be a whole number from 0 to ${MAX_AUTOMATION_LEAD_MS} milliseconds.`;
  const [toleranceText, setToleranceText] = useState(String(DEFAULT_TIMECODE_TOLERANCE_FRAMES));
  const toleranceFrames = Number(toleranceText);
  const toleranceValid = toleranceText.trim() !== "" && isValidTimecodeTolerance(toleranceFrames);
  const toleranceError = `Tolerance must be a whole number from 0 to ${MAX_TIMECODE_TOLERANCE_FRAMES} frames.`;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const attemptRef = useRef<{ signature: string; id: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!connected || saving) return;
    setError("");
    if (!toleranceValid) { setError(toleranceError); return; }
    if (!leadValid) { setError(leadError); return; }

    const tc = parseTimecodeString(tcString);
    if (!tc || !isValidTimecode(tc, format)) {
      setError(`Invalid timecode for ${format.frameRate}fps ${format.dropFrame.toUpperCase()}.`);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = usesTargetPicker
        ? action === "rundown-goto-item" ? { itemId: targetSelection?.id } : { deviceId: targetSelection?.id }
        : structuredProPresenter
        ? { ...(action === "pp-trigger-prop" ? { propName: propName.trim() } : {}), ...(propTarget.trim() ? { target: propTarget.trim() } : {}) }
        : JSON.parse(payloadJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
      payload = Object.fromEntries(Object.entries(parsed));
    } catch {
      setError("Invalid payload JSON.");
      return;
    }

    if (usesTargetPicker && !targetSelection) { setError("Choose a target before saving this cue."); return; }
    const payloadProblem = automationPayloadProblem({ action, payload });
    if (payloadProblem) { setError(payloadProblem); return; }
    const draft: NewAutomationEvent = {
      enabled: true,
      triggerTimecode: tc,
      action,
      payload,
      label: label || (usesTargetPicker && targetSelection ? `${action === "rundown-goto-item" ? "Jump to" : "Blackout"} ${targetSelection.label}` : "") || ACTION_OPTIONS.find((o) => o.value === action)?.label || action,
      toleranceFrames,
      leadMs,
      category: ACTION_OPTIONS.find((o) => o.value === action)?.category,
    };
    const signature = JSON.stringify(draft);
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, id: createBrowserId() };
    setSaving(true);
    try {
      await onAdd({ ...draft, id: attemptRef.current.id });
      setTcString(""); setLabel(""); setPayloadJson("{}"); setPropName(""); setPropTarget(""); setTargetSelection(null); setToleranceText(String(DEFAULT_TIMECODE_TOLERANCE_FRAMES)); setLeadText("0"); attemptRef.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save was not confirmed. Your changes have been kept.");
    } finally { setSaving(false); }
  }

  const INPUT_CLASS =
    "min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text outline-none focus:border-fire-500/50 transition-colors";

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-board-border bg-board-card p-4 space-y-3"
    >
      <fieldset disabled={!connected || saving} className="min-w-0 space-y-3 disabled:opacity-60">
      <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
        Add Automation Event
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Timecode (HH:MM:SS:FF)
          </label>
          <input
            type="text"
            value={tcString}
            onChange={(e) => setTcString(e.target.value)}
            placeholder="00:05:00:00"
            className={`${INPUT_CLASS} font-mono`}
            required
          />
        </div>
        <div>
          <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
            Action
          </label>
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value as AutomationActionType); setTargetSelection(null); }}
            className={INPUT_CLASS}
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
          Label
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={workspaceCopy(
            'e.g. "Fade to worship set"',
            workspaceTerms,
          )}
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor={leadId} className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">Cue lead (ms)</label>
        <input id={leadId} type="number" min={0} max={MAX_AUTOMATION_LEAD_MS} step={1} required
          value={leadText} onChange={event => setLeadText(event.target.value)} aria-invalid={!leadValid}
          aria-describedby={`${leadId}-help`} className={INPUT_CLASS} />
        <p id={`${leadId}-help`} className="mt-1 text-xs text-board-muted">Send early by this amount, plus the saved device latency, rounded up to whole frames. The cue's time stays unchanged; dispatch cannot precede 00:00:00:00.</p>
        {!leadValid && <p role="alert" className="mt-1 text-xs text-red-400">{leadError}</p>}
      </div>

      <div>
        <label htmlFor={toleranceId} className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">Tolerance (frames)</label>
        <input id={toleranceId} type="number" min={0} max={MAX_TIMECODE_TOLERANCE_FRAMES} step={1} required
          value={toleranceText} onChange={event => setToleranceText(event.target.value)}
          aria-invalid={!toleranceValid} aria-describedby={`${toleranceId}-help`} className={INPUT_CLASS} />
        <p id={`${toleranceId}-help`} className="mt-1 text-xs leading-relaxed text-board-muted">
          Used only for startup and resync matching{toleranceValid ? ` (±${toleranceFrames} frames, about ${Math.round(toleranceFrames * 1000 / format.frameRate)} ms)` : ""}.
          {" "}Forward playback fires when the clock crosses the cue. Failed actions retry only within this cue window.
        </p>
        {!toleranceValid && <p role="alert" className="mt-1 text-xs text-red-400">{toleranceError}</p>}
      </div>

      {usesTargetPicker ? <AutomationTargetPicker key={action} kind={action} loadOptions={loadTargets} selection={targetSelection} onSelect={setTargetSelection} /> : structuredProPresenter ? <div className="space-y-3">
        {action === "pp-trigger-prop" && <div>
          <label htmlFor={propNameId} className="mb-1 block text-xs text-board-muted">Prop name</label>
          <input id={propNameId} value={propName} onChange={event => setPropName(event.target.value)} required maxLength={200} className={INPUT_CLASS} />
          <p className="mt-1 text-xs text-board-muted">Use the exact name in ProPresenter. Clear existing props, wait 200 ms, then trigger this prop. Slides and other layers stay visible.</p>
        </div>}
        <div>
          <label htmlFor={targetId} className="mb-1 block text-xs text-board-muted">ProPresenter target (optional)</label>
          <input id={targetId} value={propTarget} onChange={event => setPropTarget(event.target.value)} placeholder="propresenter:192.168.1.20:50001" className={INPUT_CLASS} />
          <p className="mt-1 text-xs text-board-muted">Leave blank when only one ProPresenter is connected. Otherwise, use its connected target address.</p>
        </div>
        {action === "pp-clear-props" && <p className="text-xs text-board-muted">Clears only the props layer.</p>}
      </div> : <div>
        <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
          Action details (JSON)
        </label>
        <textarea
          value={payloadJson}
          onChange={(e) => setPayloadJson(e.target.value)}
          rows={2}
          className={`${INPUT_CLASS} font-mono text-xs resize-none`}
        />
        <p className="mt-1 text-[10px] leading-4 text-board-muted">
          {action === "stage-message" ? 'Use {"message":"Stand by"}.' : action === "rundown-adjust" ? 'Use {"deltaMs":30000} to add 30 seconds.' : action === "device-action" || action === "lighting-scene" ? "Include the device/action identifiers configured in Devices." : action === "custom-webhook" ? 'Use {"url":"https://…"}.' : "No details are required for this action."}
        </p>
      </div>}

      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={!toleranceValid || !leadValid || (usesTargetPicker && !targetSelection)}
        className="flex min-h-11 items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2 text-sm font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        {saving ? "Waiting for relay…" : "Add Event"}
      </button>
      </fieldset>
      {!connected && <p role="status" className="text-xs text-amber-200">Reconnect to add this event. Your draft is kept here.</p>}
    </form>
  );
}
