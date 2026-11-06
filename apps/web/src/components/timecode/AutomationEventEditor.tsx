import { BasicCueFields } from "./BasicCueFields";
import type { CueDetails } from "@/lib/automation-catalog";
import { parseNamedTimerDuration, formatNamedTimerRemaining } from "@/lib/named-timers";
import { MediaCueFields } from "./MediaCueFields";
import type { MediaAsset } from "@/lib/media-library";
import { isTriggerControlAction } from "@/lib/automation-execution";
import { automationPayloadProblem } from "@/lib/automation-payload";
import { AutomationTargetPicker, type AutomationTargetOption, type LoadAutomationTargets } from "./AutomationTargetPicker";
import { DEFAULT_TIMECODE_TOLERANCE_FRAMES, MAX_TIMECODE_TOLERANCE_FRAMES } from "@/types/timecode";
import { isValidTimingMs, MAX_AUTOMATION_LEAD_MS } from "@/lib/automation-timing";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useId, useMemo, useRef, useState } from "react";
import { createBrowserId } from "@/lib/browser-id";
import type { NewAutomationEvent } from "@/hooks/useTimecode";
import { Plus } from "lucide-react";
import type {
  AutomationActionType, AutomationEvent,
} from "@/types/timecode";
import { timecodeToString, isSafeAutomationWebhookUrl, isValidTimecode, isValidTimecodeTolerance, parseTimecodeString } from "@/lib/timecode";

interface AutomationEventEditorProps {
  onAdd: (event: NewAutomationEvent) => Promise<void>;
  connected: boolean;
  editing?: AutomationEvent;
  blockedReason?: string;
  loadTargets?: LoadAutomationTargets;
  timerNames?: string[];
  orgId?: string;
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
  { value: "triggers-disable", label: "Pause Automatic Cues", category: "Automation" },
  { value: "triggers-enable", label: "Resume Automatic Cues", category: "Automation" },
  { value: "timer-start", label: "Start Named Timer", category: "Timers" },
  { value: "timer-stop", label: "Stop Named Timer", category: "Timers" },
  { value: "media-play", label: "Play Media", category: "Media" },
  { value: "media-stop", label: "Stop Media", category: "Media" },
  { value: "crew-message", label: "Post to Production Chat", category: "Crew" },
  { value: "stage-clear", label: "Clear Stage Message", category: "Stage Display" },
  { value: "device-action", label: "Trigger Device Action", category: "Devices" },
  { value: "lighting-scene", label: "Recall Lighting Scene", category: "Devices" },
  { value: "lighting-blackout", label: "Lighting Blackout", category: "Devices" },
  { value: "lyrics-goto", label: "Show Lyrics Section", category: "Lyrics" },
  { value: "lyrics-next-section", label: "Next Lyrics Section", category: "Lyrics" },
  { value: "lyrics-previous-section", label: "Previous Lyrics Section", category: "Lyrics" },
  { value: "lyrics-clear", label: "Clear Lyrics", category: "Lyrics" },
  { value: "pp-trigger-slide", label: "Trigger ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-next", label: "Next ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-previous", label: "Previous ProPresenter Slide", category: "Lyrics" },
  { value: "pp-trigger-prop", label: "Trigger ProPresenter Prop", category: "ProPresenter" },
  { value: "pp-clear-props", label: "Clear ProPresenter Props", category: "ProPresenter" },
  { value: "pp-trigger-clear", label: "Clear ProPresenter Slide", category: "Lyrics" },
  { value: "custom-webhook", label: "Custom Webhook", category: "Other" },
];

export function AutomationEventEditor({ onAdd, format, connected, loadTargets, timerNames = [], orgId, editing, blockedReason }: AutomationEventEditorProps) {
  const workspaceTerms = useWorkspaceTerms();
  const text = (key: string, fallback = "") => typeof editing?.payload[key] === "string" ? editing.payload[key] : fallback;
  const [changeDetails, setChangeDetails] = useState(!editing);
  const [tcString, setTcString] = useState(editing ? timecodeToString(editing.triggerTimecode, format.dropFrame === "df") : "");
  const [action, setAction] = useState<AutomationActionType>(editing?.action ?? "lower-third-show");
  const [label, setLabel] = useState(editing?.label ?? "");
  const initialDetails = useMemo(() => ({ ...(editing?.payload ?? {}),
    ...(editing?.targetDeviceId ? { deviceId: editing.targetDeviceId } : {}),
    ...(editing?.targetActionId ? { actionId: editing.targetActionId } : {}),
  }), [editing]);
  const [details, setDetails] = useState<CueDetails>({ status: "invalid", message: "Complete the action fields." });
  const [detailsGeneration, setDetailsGeneration] = useState(0);
  const [crewMessage, setCrewMessage] = useState(text("message"));
  const crewMessageId = useId();
  const [targetSelection, setTargetSelection] = useState<AutomationTargetOption | null>(null);
  const usesTargetPicker = action === "rundown-goto-item" || action === "rundown-start-item" || action === "lighting-blackout";
  const namedTimer = action === "timer-start" || action === "timer-stop";
  const mediaAction = action === "media-play" || action === "media-stop";
  const [mediaOutput, setMediaOutput] = useState(text("output", "Program"));
  const [mediaAsset, setMediaAsset] = useState<MediaAsset | null>(null);
  const [mediaVolume, setMediaVolume] = useState(typeof editing?.payload.volume === "number" ? String(editing.payload.volume * 100) : "100");
  const mediaVolumeValid = mediaVolume.trim() !== "" && Number.isInteger(Number(mediaVolume)) && Number(mediaVolume) >= 0 && Number(mediaVolume) <= 100;
  const timerNameId = useId();
  const timerDurationId = useId();
  const [timerName, setTimerName] = useState(text("name"));
  const [timerDuration, setTimerDuration] = useState(typeof editing?.payload.durationMs === "number" ? formatNamedTimerRemaining(editing.payload.durationMs) : "5:00");
  const timerDurationMs = parseNamedTimerDuration(timerDuration);
  const controlsTriggers = isTriggerControlAction(action);
  const stepsLyrics = action === "lyrics-next-section" || action === "lyrics-previous-section";
  const propNameId = useId();
  const targetId = useId();
  const [propName, setPropName] = useState(text("propName"));
  const [propTarget, setPropTarget] = useState(text("target"));
  const structuredProPresenter = action === "pp-trigger-prop" || action === "pp-clear-props" || action === "pp-trigger-previous" || action === "pp-trigger-next" || action === "pp-trigger-clear";
  const basicFields = !mediaAction && !namedTimer && !controlsTriggers && action !== "crew-message" && action !== "lyrics-clear" && !stepsLyrics && !usesTargetPicker && !structuredProPresenter && action !== "custom-webhook";
  const toleranceId = useId();
  const leadId = useId();
  const [leadText, setLeadText] = useState(String(editing?.leadMs ?? 0));
  const leadMs = Number(leadText);
  const leadValid = leadText.trim() !== "" && isValidTimingMs(leadMs);
  const leadError = `Cue lead must be a whole number from 0 to ${MAX_AUTOMATION_LEAD_MS} milliseconds.`;
  const [toleranceText, setToleranceText] = useState(String(editing?.toleranceFrames ?? DEFAULT_TIMECODE_TOLERANCE_FRAMES));
  const toleranceFrames = Number(toleranceText);
  const toleranceValid = toleranceText.trim() !== "" && isValidTimecodeTolerance(toleranceFrames);
  const toleranceError = `Tolerance must be a whole number from 0 to ${MAX_TIMECODE_TOLERANCE_FRAMES} frames.`;
  const [webhookUrl, setWebhookUrl] = useState(text("url"));
  const webhookId = useId();
  const timecodeId = useId();
  const labelId = useId();
  const actionId = useId();
  const parsedTimecode = parseTimecodeString(tcString);
  const timecodeValid = parsedTimecode !== null && isValidTimecode(parsedTimecode, format);
  const formatLabel = `${format.frameRate} fps ${format.dropFrame.toUpperCase()}`;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const attemptRef = useRef<{ signature: string; id: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!connected || saving || blockedReason) return;
    setError("");
    if (!toleranceValid) { setError(toleranceError); return; }
    if (!leadValid) { setError(leadError); return; }

    const tc = parseTimecodeString(tcString);
    if (!tc || !isValidTimecode(tc, format)) {
      setError(`Invalid timecode for ${formatLabel}.`);
      return;
    }

    if (changeDetails && basicFields && details.status === "invalid") { setError(details.message); return; }
    let payload: Record<string, unknown>;
    if (editing && !changeDetails) payload = initialDetails;
    else if (action === "custom-webhook") payload = { ...(editing?.payload ?? {}), url: webhookUrl.trim() };
    else if (mediaAction) payload = {
      output: mediaOutput.trim(),
      ...(action === "media-play" ? { mediaId: mediaAsset?.id, etag: mediaAsset?.etag, volume: mediaVolumeValid ? Number(mediaVolume) / 100 : null } : {}),
    };
    else if (namedTimer) payload = { name: timerName.trim(), ...(action === "timer-start" ? { durationMs: timerDurationMs } : {}) };
    else if (action === "crew-message") payload = { message: crewMessage.trim() };
    else if (stepsLyrics || controlsTriggers || action === "lyrics-clear") payload = {};
    else if (usesTargetPicker) payload = action === "lighting-blackout" ? { deviceId: targetSelection?.id } : { itemId: targetSelection?.id };
    else if (structuredProPresenter) payload = {
      ...(action === "pp-trigger-prop" ? { propName: propName.trim() } : {}),
      ...(propTarget.trim() ? { target: propTarget.trim() } : {}),
    };
    else payload = details.status === "ready" ? details.payload : {};


    if (changeDetails && usesTargetPicker && !targetSelection) { setError("Choose a target before saving this cue."); return; }
    if (changeDetails && action === "custom-webhook" && !isSafeAutomationWebhookUrl(payload.url)) { setError("Enter a public HTTPS webhook URL."); return; }
    const payloadProblem = automationPayloadProblem({ action, payload });
    if (payloadProblem) { setError(payloadProblem); return; }
    const draft: NewAutomationEvent = {
      enabled: true,
      triggerTimecode: tc,
      action,
      payload,
      label: label || (mediaAction ? action === "media-play" ? `Play ${mediaAsset?.name ?? "media"} on ${mediaOutput.trim()}` : `Stop media on ${mediaOutput.trim()}` : "") || (namedTimer ? `${action === "timer-start" ? "Start" : "Stop"} ${timerName.trim()}` : "") || (usesTargetPicker && targetSelection ? `${action === "lighting-blackout" ? "Blackout" : action === "rundown-goto-item" ? "Jump to" : "Start"} ${targetSelection.label}` : "") || ACTION_OPTIONS.find((o) => o.value === action)?.label || action,
      toleranceFrames,
      leadMs,
      category: ACTION_OPTIONS.find((o) => o.value === action)?.category,
    };
    const signature = JSON.stringify(draft);
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, id: createBrowserId() };
    setSaving(true);
    try {
      await onAdd({ ...draft, id: editing?.id ?? attemptRef.current.id });
      if (editing) return;
      setTcString(""); setLabel(""); setDetailsGeneration(value => value + 1); setCrewMessage(""); setPropName(""); setPropTarget(""); setTargetSelection(null); setToleranceText(String(DEFAULT_TIMECODE_TOLERANCE_FRAMES)); setLeadText("0"); attemptRef.current = null;
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
      <fieldset disabled={!connected || saving || Boolean(blockedReason)} className="min-w-0 space-y-3 disabled:opacity-60">
      <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
        {editing ? "Edit Automation Event" : "Add Automation Event"}
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={timecodeId} className="text-xs text-board-muted uppercase tracking-wider mb-1 block">
            Timecode (HH:MM:SS:FF)
          </label>
          <input
            type="text"
            id={timecodeId}
            aria-invalid={tcString.length > 0 && !timecodeValid}
            aria-describedby={`${timecodeId}-format`}
            value={tcString}
            onChange={(e) => setTcString(e.target.value)}
            placeholder="00:05:00:00"
            className={`${INPUT_CLASS} font-mono`}
            required
          />
          <p id={`${timecodeId}-format`} className="mt-1 text-xs text-board-muted">{formatLabel}</p>
          {tcString.length > 0 && !timecodeValid && <p role="alert" className="mt-1 text-xs text-red-400">Enter a valid timecode for {formatLabel}.</p>}
        </div>
        <div>
          <label htmlFor={actionId} className="text-xs text-board-muted uppercase tracking-wider mb-1 block">
            Action
          </label>
          <select
            id={actionId}
            disabled={Boolean(editing)}
            value={action}
            onChange={(e) => { setAction(e.target.value as AutomationActionType); setTargetSelection(null); setDetails({ status: "invalid", message: "Complete the action fields." }); }}
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
        <label htmlFor={labelId} className="text-xs text-board-muted uppercase tracking-wider mb-1 block">
          Label
        </label>
        <input
          type="text"
          id={labelId}
          maxLength={200}
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
        <label htmlFor={leadId} className="text-xs text-board-muted uppercase tracking-wider mb-1 block">Cue lead (ms)</label>
        <input id={leadId} type="number" min={0} max={MAX_AUTOMATION_LEAD_MS} step={1} required
          value={leadText} onChange={event => setLeadText(event.target.value)} aria-invalid={!leadValid}
          aria-describedby={`${leadId}-help`} className={INPUT_CLASS} />
        <p id={`${leadId}-help`} className="mt-1 text-xs text-board-muted">Send early by this amount, plus the saved device latency, rounded up to whole frames. The cue's time stays unchanged; dispatch cannot precede 00:00:00:00.</p>
        {!leadValid && <p role="alert" className="mt-1 text-xs text-red-400">{leadError}</p>}
      </div>

      <div>
        <label htmlFor={toleranceId} className="text-xs text-board-muted uppercase tracking-wider mb-1 block">Tolerance (frames)</label>
        <input id={toleranceId} type="number" min={0} max={MAX_TIMECODE_TOLERANCE_FRAMES} step={1} required
          value={toleranceText} onChange={event => setToleranceText(event.target.value)}
          aria-invalid={!toleranceValid} aria-describedby={`${toleranceId}-help`} className={INPUT_CLASS} />
        <p id={`${toleranceId}-help`} className="mt-1 text-xs leading-relaxed text-board-muted">
          Used only for startup and resync matching{toleranceValid ? ` (±${toleranceFrames} frames, about ${Math.round(toleranceFrames * 1000 / format.frameRate)} ms)` : ""}.
          {" "}Forward playback fires when the clock crosses the cue. Failed actions retry only within this cue window.
        </p>
        {!toleranceValid && <p role="alert" className="mt-1 text-xs text-red-400">{toleranceError}</p>}
      </div>

      {editing && <label className="flex min-h-11 items-center gap-2 text-sm text-board-text"><input type="checkbox" checked={changeDetails} onChange={event => setChangeDetails(event.target.checked)} />Change action details</label>}
      {!changeDetails ? <p className="text-sm text-board-muted">The cue keeps its saved action details. Editing does not fire or re-arm it.</p> : action === "custom-webhook" ? <div className="space-y-2">
        <label htmlFor={webhookId} className="block text-xs text-board-muted">Webhook URL</label>
        <input id={webhookId} type="url" required value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} className={INPUT_CLASS} placeholder="https://hooks.example.com/show" />
        {webhookUrl.length > 0 && !isSafeAutomationWebhookUrl(webhookUrl) && <p role="alert" className="text-xs text-red-400">Enter a public HTTPS webhook URL without credentials or a custom port.</p>}
      </div> : mediaAction ? <MediaCueFields key={action} orgId={orgId} play={action === "media-play"} output={mediaOutput} onOutput={setMediaOutput} asset={mediaAsset} onAsset={setMediaAsset} volume={mediaVolume} onVolume={setMediaVolume} /> : namedTimer ? <div className="space-y-3">
        <div><label htmlFor={timerNameId} className="mb-1 block text-xs text-board-muted">Timer name</label>
          <input id={timerNameId} list={`${timerNameId}-options`} value={timerName} onChange={event => setTimerName(event.target.value)} maxLength={80} required className={INPUT_CLASS} placeholder="Speaker countdown" />
          <datalist id={`${timerNameId}-options`}>{timerNames.map(name => <option key={name} value={name} />)}</datalist>
        </div>
        {action === "timer-start" && <div><label htmlFor={timerDurationId} className="mb-1 block text-xs text-board-muted">Duration (m:ss)</label>
          <input id={timerDurationId} value={timerDuration} onChange={event => setTimerDuration(event.target.value)} required aria-invalid={timerDurationMs === null} aria-describedby={`${timerDurationId}-help`} className={INPUT_CLASS} placeholder="5:00" />
          <p id={`${timerDurationId}-help`} className="mt-1 text-xs text-board-muted">Enter minutes or m:ss, from 0:01 to 1440:00. The timer continues when timecode stops.</p>
          {timerDurationMs === null && <p role="alert" className="text-xs text-red-400">Enter a duration from 0:01 to 1440:00.</p>}
        </div>}
        <p className="text-xs text-board-muted">{action === "timer-start" ? "Show this countdown on the confidence display. Firing Start again restarts the same named timer. A Retry after a lost acknowledgment preserves its countdown."
          : "Stop and remove this named countdown from the confidence display. Other timers and the rundown keep running."}</p>
      </div> : controlsTriggers ? <p className="text-xs text-board-muted">
        {action === "triggers-disable" ? "Pause automatic firing while the clock continues. Manual Fire remains available. Add a Resume Automatic Cues event or resume from the operator controls."
          : "Resume automatic firing from the current timecode. Missed cues will not replay. This cannot override the safety kill switch or an unresolved timecode hold."}
        {" "}If pause and resume share a dispatch time, pause wins.
      </p> : action === "crew-message" ? <div className="space-y-2">
        <label htmlFor={crewMessageId} className="block text-xs text-board-muted">Crew message</label>
        <textarea id={crewMessageId} required maxLength={4000} rows={3} value={crewMessage} onChange={event => setCrewMessage(event.target.value)} className={INPUT_CLASS} />
        <p className="text-xs text-board-muted">Post to Production Chat as the controlling operator. Delivery to any linked chat service is shown separately in Chat.</p>
      </div> : action === "lyrics-clear" ? <p className="text-sm text-board-muted">Clears the currently displayed native lyrics, including manually selected sections. Use the song loader’s “Clear after last cue” option for a clear that applies only to that song load.</p> : stepsLyrics ? <p className="text-xs text-board-muted">Move to the {action === "lyrics-next-section" ? "next" : "previous"} section of the currently displayed song, using its saved section order. Show a section first. At the song boundary, the cue reports an error and keeps the current lyrics.</p> : usesTargetPicker ? <AutomationTargetPicker key={action} kind={action} loadOptions={loadTargets} selection={targetSelection} onSelect={setTargetSelection} /> : structuredProPresenter ? <div className="space-y-3">
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
      </div> : <BasicCueFields key={`${action}:${detailsGeneration}`} action={action} initial={initialDetails} orgId={orgId} onChange={setDetails} />}

      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={!timecodeValid || !toleranceValid || !leadValid || (changeDetails && basicFields && details.status !== "ready") || (changeDetails && ((action === "custom-webhook" && !isSafeAutomationWebhookUrl(webhookUrl)) || (mediaAction && (!mediaOutput.trim() || (action === "media-play" && (!mediaAsset || !mediaVolumeValid)))) || (namedTimer && (!timerName.trim() || (action === "timer-start" && timerDurationMs === null))) || (usesTargetPicker && !targetSelection)))}
        className="flex min-h-11 items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2 text-sm font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        {saving ? "Waiting for relay…" : editing ? "Save changes" : "Add Event"}
      </button>
      </fieldset>
      {!connected && <p role="status" className="text-xs text-amber-200">Reconnect to save this event. Your draft is kept here.</p>}
      {connected && blockedReason && <p role="status" className="text-xs text-amber-200">{blockedReason}</p>}
    </form>
  );
}
