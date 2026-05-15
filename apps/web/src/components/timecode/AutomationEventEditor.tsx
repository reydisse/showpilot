import { useState } from "react";
import { Plus } from "lucide-react";
import type {
  AutomationEvent,
  AutomationActionType,
} from "@/types/timecode";
import { parseTimecodeString } from "@/lib/timecode";

interface AutomationEventEditorProps {
  onAdd: (event: Omit<AutomationEvent, "id" | "fired" | "triggerFrame">) => void;
}

const ACTION_OPTIONS: { value: AutomationActionType; label: string; category: string }[] = [
  { value: "device-action", label: "Device Action", category: "Devices" },
  { value: "lower-third-show", label: "Show Lower Third", category: "Lower Thirds" },
  { value: "lower-third-clear", label: "Clear Lower Third", category: "Lower Thirds" },
  { value: "rundown-advance", label: "Advance Rundown", category: "Rundown" },
  { value: "rundown-start-item", label: "Start Rundown Item", category: "Rundown" },
  { value: "lighting-scene", label: "Recall Lighting Scene", category: "Lighting" },
  { value: "custom-webhook", label: "Custom Webhook", category: "Other" },
];

export function AutomationEventEditor({ onAdd }: AutomationEventEditorProps) {
  const [tcString, setTcString] = useState("");
  const [action, setAction] = useState<AutomationActionType>("lower-third-show");
  const [label, setLabel] = useState("");
  const [payloadJson, setPayloadJson] = useState("{}");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const tc = parseTimecodeString(tcString);
    if (!tc) {
      setError("Invalid timecode. Use HH:MM:SS:FF format.");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      setError("Invalid payload JSON.");
      return;
    }

    onAdd({
      triggerTimecode: tc,
      action,
      payload,
      label: label || ACTION_OPTIONS.find((o) => o.value === action)?.label || action,
      toleranceFrames: 2,
      category: ACTION_OPTIONS.find((o) => o.value === action)?.category,
    });

    // Reset
    setTcString("");
    setLabel("");
    setPayloadJson("{}");
  }

  const INPUT_CLASS =
    "w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text outline-none focus:border-fire-500/50 transition-colors";

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-board-border bg-board-card p-4 space-y-3"
    >
      <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
        Add Automation Event
      </h3>

      <div className="grid grid-cols-2 gap-3">
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
            onChange={(e) => setAction(e.target.value as AutomationActionType)}
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
          placeholder='e.g. "Fade to worship set"'
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label className="text-[10px] text-board-muted uppercase tracking-wider mb-1 block">
          Payload (JSON)
        </label>
        <textarea
          value={payloadJson}
          onChange={(e) => setPayloadJson(e.target.value)}
          rows={2}
          className={`${INPUT_CLASS} font-mono text-xs resize-none`}
        />
      </div>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <button
        type="submit"
        className="flex items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2 text-sm font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Event
      </button>
    </form>
  );
}
