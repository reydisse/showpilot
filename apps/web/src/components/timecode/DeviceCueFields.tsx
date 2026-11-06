import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getAutomationDeviceTargets } from "@/lib/automation-targets";
import { normalizeActionParams } from "@/lib/device-modules/action-params";
import type { AutomationDeviceTarget, CueDetails } from "@/lib/automation-catalog";
import type { ModuleAction } from "@/lib/device-modules/types";
import { useCueChoices } from "./useCueChoices";

const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text";
export function DeviceCueFields({ orgId, lighting, initial, onChange, loadDevices }: {
  orgId?: string; lighting: boolean; initial: Record<string, unknown>; onChange: (details: CueDetails) => void;
  loadDevices?: () => Promise<AutomationDeviceTarget[]>;
}) {
  const load = useCallback(() => loadDevices ? loadDevices() : orgId ? getAutomationDeviceTargets({ data: { orgId } }) : Promise.reject(new Error("Select a workspace before choosing a device.")), [loadDevices, orgId]);
  const { choices, retry } = useCueChoices(load);
  const [deviceId, setDeviceId] = useState(typeof initial.deviceId === "string" ? initial.deviceId : "");
  const [actionId, setActionId] = useState(typeof initial.actionId === "string" ? initial.actionId : lighting ? "recall_scene" : "");
  const [params, setParams] = useState<Record<string, unknown>>(initial.params && typeof initial.params === "object" && !Array.isArray(initial.params) ? Object.fromEntries(Object.entries(initial.params)) : Object.fromEntries(Object.entries(initial).filter(([key]) => !["deviceId", "targetDeviceId", "actionId", "targetActionId"].includes(key))));
  const id = useId();
  const devices = choices.status === "ready" ? choices.value.filter(device => !lighting || device.category === "lighting") : [];
  const device = devices.find(option => option.id === deviceId);
  const actions = device?.actions.filter(action => !lighting || action.id === "recall_scene") ?? [];
  const action = actions.find(option => option.id === actionId);
  const details = useMemo<CueDetails>(() => {
    if (choices.status !== "ready" || !device || !action) return { status: "invalid", message: "Choose an available device and action." };
    try {
      for (const field of action.params) if (field.type === "number" && params[field.id] === "") throw new Error(`${field.label} is required.`);
      return { status: "ready", payload: { deviceId: device.id, actionId: action.id, params: normalizeActionParams(action, params) } };
    } catch (error) { return { status: "invalid", message: error instanceof Error ? error.message : "Check the action fields." }; }
  }, [choices.status, device, action, params]);
  useEffect(() => onChange(details), [details, onChange]);
  function chooseAction(value: string, available: ModuleAction[]) {
    setActionId(value);
    setParams(Object.fromEntries((available.find(action => action.id === value)?.params ?? []).filter(field => field.default !== undefined || field.type === "boolean").map(field => [field.id, field.default ?? false])));
  }
  return <div className="space-y-3">
    <div><label htmlFor={`${id}-device`} className="mb-1 block text-xs text-board-muted">{lighting ? "Lighting device" : "Device"}</label>
      <select id={`${id}-device`} className={inputClass} value={deviceId} disabled={choices.status !== "ready"} onChange={event => { setDeviceId(event.target.value); chooseAction(lighting ? "recall_scene" : "", devices.find(device => device.id === event.target.value)?.actions ?? []); }}>
        <option value="">Choose a device</option>{devices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
      </select></div>
    {device && <div><label htmlFor={`${id}-action`} className="mb-1 block text-xs text-board-muted">Device action</label>
      <select id={`${id}-action`} className={inputClass} value={actionId} onChange={event => chooseAction(event.target.value, actions)}>
        <option value="">Choose an action</option>{actions.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
      </select></div>}
    {action?.params.map(field => {
      const fieldId = `${id}-${field.id}`;
      const value = params[field.id] ?? field.default;
      const change = (value: unknown) => setParams(previous => ({ ...previous, [field.id]: value }));
      return <div key={field.id}><label htmlFor={fieldId} className="mb-1 block text-xs text-board-muted">{field.label}</label>
        {field.type === "boolean" ? <input id={fieldId} type="checkbox" className="h-6 w-6" checked={value === true} onChange={event => change(event.target.checked)} />
          : field.type === "select" ? <select id={fieldId} className={inputClass} value={typeof value === "string" ? value : ""} onChange={event => change(event.target.value)}><option value="">Choose {field.label.toLowerCase()}</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input id={fieldId} className={inputClass} type={field.type === "number" ? "number" : "text"} min={field.min} max={field.max} step={field.step ?? "any"} maxLength={256} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={event => change(event.target.value)} />}
      </div>;
    })}
    {choices.status === "loading" && <p role="status" className="text-xs text-board-muted">Loading devices…</p>}
    {choices.status === "error" && <p role="alert" className="text-xs text-red-300">{choices.message}</p>}
    {choices.status === "ready" && devices.length === 0 && <p className="text-xs text-board-muted">Add an enabled device with supported actions in Devices first.</p>}
    {device && actions.length === 0 && <p className="text-xs text-board-muted">This device has no supported scene recall action.</p>}
    {device && action && details.status === "invalid" && <p role="alert" className="text-xs text-red-300">{details.message}</p>}
    <button type="button" disabled={choices.status === "loading"} onClick={retry} className="min-h-11 rounded-lg border border-board-border px-3 text-xs">Refresh devices</button>
  </div>;
}
