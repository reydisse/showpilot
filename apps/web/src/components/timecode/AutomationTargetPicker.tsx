import { useEffect, useId, useState } from "react";

export type AutomationTargetKind = "rundown-goto-item" | "lighting-blackout";
export interface AutomationTargetOption { id: string; label: string }
export type LoadAutomationTargets = (kind: AutomationTargetKind) => Promise<AutomationTargetOption[]>;
type Choices = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; options: AutomationTargetOption[] };

export function AutomationTargetPicker({ kind, loadOptions, selection, onSelect }: {
  kind: AutomationTargetKind;
  loadOptions?: LoadAutomationTargets;
  selection: AutomationTargetOption | null;
  onSelect: (option: AutomationTargetOption | null) => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Choices>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const noun = kind === "rundown-goto-item" ? "rundown items" : "lighting devices";
  useEffect(() => {
    let current = true;
    setChoices({ status: "loading" });
    onSelect(null);
    const timer = setTimeout(() => {
      current = false;
      setChoices({ status: "error", message: `Loading ${noun} timed out.` });
    }, 10000);
    void (loadOptions ? loadOptions(kind) : Promise.reject(new Error("Select a show before choosing a target.")))
      .then(options => { if (current) setChoices({ status: "ready", options }); })
      .catch(error => { if (current) setChoices({ status: "error", message: error instanceof Error ? error.message : `Could not load ${noun}.` }); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); };
  }, [kind, loadOptions, refresh, noun, onSelect]);
  return <div className="min-w-0 space-y-2">
    <label htmlFor={id} className="block text-xs text-board-muted">{kind === "rundown-goto-item" ? "Rundown item" : "Lighting device"}</label>
    <select id={id} required value={selection?.id ?? ""} disabled={choices.status !== "ready" || choices.options.length === 0}
      onChange={event => onSelect(choices.status === "ready" ? choices.options.find(option => option.id === event.target.value) ?? null : null)}
      className="min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text">
      <option value="">Choose {kind === "rundown-goto-item" ? "an item" : "a device"}</option>
      {choices.status === "ready" && choices.options.map((option, index) => <option key={option.id} value={option.id}>{index + 1}. {option.label}</option>)}
    </select>
    {choices.status === "loading" && <p role="status" className="text-xs text-board-muted">Loading {noun}…</p>}
    {choices.status === "error" && <p role="alert" className="text-xs text-red-300">{choices.message}</p>}
    {choices.status === "ready" && choices.options.length === 0 && <p className="text-xs text-board-muted">{kind === "rundown-goto-item" ? "Add playable items to this show's rundown first." : "Add an enabled lighting device with a blackout action in Devices first."}</p>}
    <p className="text-xs text-board-muted">{kind === "rundown-goto-item" ? "Start the selected item from zero. The current item is marked complete." : "Send the dedicated blackout command. This does not recall a scene. Output stays black until restored through the device controls."}</p>
    <button type="button" disabled={choices.status === "loading"} onClick={() => setRefresh(value => value + 1)} className="min-h-11 rounded-lg border border-board-border px-3 text-xs text-board-text disabled:opacity-50">{choices.status === "error" ? "Retry loading targets" : "Refresh targets"}</button>
  </div>;
}
