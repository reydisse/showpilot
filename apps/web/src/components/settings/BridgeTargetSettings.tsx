import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { approveBridgeDestination, getBridgeTargetPolicy, removeBridgeDestination } from "@/lib/bridge-target-settings";
import { BRIDGE_TARGET_PROTOCOLS } from "@showpilot/shared/bridge-target";
import type { ApprovedBridgeTarget } from "@/lib/bridge-targets.server";
import type { BridgeDeviceProtocol } from "@/lib/device-modules/types";

const protocolNames: Record<BridgeDeviceProtocol, string> = {
  atem: "ATEM", "dmx-artnet": "Art-Net", "dmx-sacn": "sACN", "http-command": "HTTP / HTTPS",
  obs: "OBS", osc: "OSC", pjlink: "PJLink", propresenter: "ProPresenter", "tcp-command": "TCP",
  udp: "UDP", "visca-ip": "VISCA over IP", wol: "Wake-on-LAN",
};
const fieldClass = "mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text";

export function BridgeTargetSettings({ orgId }: { orgId: string }) {
  return <Targets key={orgId} orgId={orgId} />;
}
function Targets({ orgId }: { orgId: string }) {
  const [targets, setTargets] = useState<ApprovedBridgeTarget[]>([]);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState<BridgeDeviceProtocol>("obs");
  const [removal, setRemoval] = useState<ApprovedBridgeTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    void getBridgeTargetPolicy({ data: { orgId } })
      .then(items => { if (current.current) setTargets(items); })
      .catch(cause => { if (current.current) setError(cause instanceof Error ? cause.message : "Could not load approved destinations."); })
      .finally(() => { if (current.current) setLoading(false); });
    return () => { current.current = false; };
  }, [orgId]);

  async function change(action: "approve" | "remove") {
    if (busy || (action === "remove" && !removal)) return;
    setBusy(true); setError(null);
    try {
      const result = action === "approve"
        ? await approveBridgeDestination({ data: { orgId, label, host, port, protocol } })
        : await removeBridgeDestination({ data: { orgId, id: removal!.id, confirmed: true } });
      if (!current.current) return;
      setTargets(result.targets);
      setError(result.warning);
      if (action === "approve") { setLabel(""); setHost(""); setPort(""); }
    } catch (cause) { if (current.current) setError(cause instanceof Error ? cause.message : "Could not change destination approval."); }
    finally { if (current.current) { setBusy(false); setRemoval(null); } }
  }
  return <section className="space-y-4 rounded-xl border border-board-border bg-board-card p-4">
    <div><h3 className="text-sm font-semibold text-board-text">Approved Bridge destinations</h3>
      <p className="mt-1 text-xs text-board-muted">Approve the host, port and protocol for each venue device. Only API-key or integration administrators can change this list.</p></div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <form className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void change("approve"); }}>
      <label className="min-w-0 text-xs text-board-muted">Destination name<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="Main room OBS" className={fieldClass} /></label>
      <label className="min-w-0 text-xs text-board-muted">Host or IP address<input required maxLength={253} value={host} onChange={event => setHost(event.target.value)} placeholder="192.168.1.20" className={fieldClass} /></label>
      <label className="min-w-0 text-xs text-board-muted">Port<input required type="number" min={1} max={65535} step={1} value={port} onChange={event => setPort(event.target.value)} placeholder="4455" className={fieldClass} /></label>
      <label className="min-w-0 text-xs text-board-muted">Protocol<select value={protocol} onChange={event => { const selected = BRIDGE_TARGET_PROTOCOLS.find(value => value === event.target.value); if (selected) setProtocol(selected); }} className={fieldClass}>
        {BRIDGE_TARGET_PROTOCOLS.map(value => <option key={value} value={value}>{protocolNames[value]}</option>)}
      </select></label>
      {protocol === "propresenter" && <p className="text-xs text-board-muted sm:col-span-2">Approve each configured port. ProPresenter commonly uses 50001 for stage display and 1025 for its API.</p>}
      {protocol === "wol" && <p className="text-xs text-board-muted sm:col-span-2">Wake-on-LAN sends to broadcast address 255.255.255.255 on port 9.</p>}
      <button type="submit" disabled={busy || loading} className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text disabled:opacity-40 sm:col-span-2">Approve destination</button>
    </form>
    {loading ? <p className="text-xs text-board-muted">Loading approved destinations…</p> : targets.length === 0
      ? <p className="text-xs text-board-muted">No Bridge destinations approved yet.</p>
      : <ul className="divide-y divide-board-border">{targets.map(target => <li key={target.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0"><p className="break-words text-sm text-board-text">{target.label}</p><p className="break-all text-xs text-board-muted">{target.host}:{target.port} · {protocolNames[target.protocol]}</p></div>
        <button type="button" aria-label={`Remove approval for ${target.label}`} disabled={busy} onClick={() => setRemoval(target)} className="min-h-11 rounded-lg border border-red-500/30 px-3 text-xs text-red-300 disabled:opacity-40">Remove approval</button>
      </li>)}</ul>}
    <ConfirmDialog open={removal !== null} onOpenChange={open => { if (!open && !busy) setRemoval(null); }} title={`Remove approval for ${removal?.label ?? "this destination"}?`}
      description="Bridge commands to this destination will be blocked and its device connection will be stopped, including repeating lighting output. Confirm that the equipment is no longer needed before removing its approval."
      confirmLabel="Remove approval" loading={busy} onConfirm={() => { void change("remove"); }} />
  </section>;
}
