import { LowerThirdCueFields } from "./LowerThirdCueFields";
import { useEffect, useId, useMemo, useState } from "react";
import type { AutomationActionType } from "@/types/timecode";
import type { CueDetails } from "@/lib/automation-catalog";
import { DeviceCueFields } from "./DeviceCueFields";
import { SongCueFields } from "./SongCueFields";

const noDetails = new Set<AutomationActionType>(["lower-third-clear", "rundown-advance", "rundown-previous", "rundown-pause", "rundown-resume", "rundown-stop", "stage-clear"]);
const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text";
export function BasicCueFields({ action, initial, orgId, onChange }: {
  action: AutomationActionType; initial: Record<string, unknown>; orgId?: string; onChange: (details: CueDetails) => void;
}) {
  const [message, setMessage] = useState(typeof initial.message === "string" ? initial.message : "");
  const [seconds, setSeconds] = useState(typeof initial.deltaMs === "number" ? String(initial.deltaMs / 1000) : "30");
  const id = useId();
  const complex = action === "lower-third-show" || action === "device-action" || action === "lighting-scene" || action === "lyrics-goto" || action === "pp-trigger-slide";
  const details = useMemo<CueDetails>(() => {
    if (action === "stage-message") return message.trim() && message.length <= 2000 ? { status: "ready", payload: { message } } : { status: "invalid", message: "Enter a stage message, up to 2,000 characters." };
    if (action === "rundown-adjust") {
      const deltaMs = Math.round(Number(seconds) * 1000);
      const validSeconds = /^[+-]?(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(seconds.trim());
      return validSeconds && Number.isSafeInteger(deltaMs) && Math.abs(deltaMs) <= 86_400_000 ? { status: "ready", payload: { deltaMs } } : { status: "invalid", message: "Enter seconds with up to three decimal places, within 24 hours." };
    }
    return noDetails.has(action) ? { status: "ready", payload: {} } : { status: "invalid", message: "Choose an action with supported fields." };
  }, [action, message, seconds]);
  useEffect(() => { if (!complex) onChange(details); }, [complex, details, onChange]);
  if (action === "lower-third-show") return <LowerThirdCueFields initial={initial} onChange={onChange} />;
  if (action === "device-action" || action === "lighting-scene") return <DeviceCueFields orgId={orgId} lighting={action === "lighting-scene"} initial={initial} onChange={onChange} />;
  if (action === "lyrics-goto" || action === "pp-trigger-slide") return <SongCueFields orgId={orgId} proPresenter={action === "pp-trigger-slide"} initial={initial} onChange={onChange} />;
  return <div className="space-y-3">
    {action === "stage-message" ? <div><label htmlFor={`${id}-message`} className="mb-1 block text-xs text-board-muted">Stage message</label><textarea id={`${id}-message`} className={inputClass} rows={3} maxLength={2000} value={message} onChange={event => setMessage(event.target.value)} /></div>
      : action === "rundown-adjust" ? <div><label htmlFor={`${id}-seconds`} className="mb-1 block text-xs text-board-muted">Seconds to add or subtract</label><input id={`${id}-seconds`} className={inputClass} type="number" step="0.001" min={-86400} max={86400} value={seconds} onChange={event => setSeconds(event.target.value)} /><p className="text-xs text-board-muted">Use a negative number to shorten the current item.</p></div>
        : noDetails.has(action) ? <p className="text-xs text-board-muted">No additional details are needed for this action.</p> : null}
    {details.status === "invalid" && <p role="status" className="text-xs text-board-muted">{details.message}</p>}
  </div>;
}
