import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { getBridgeSelection, takeBridgeControl } from "@/lib/bridge-selection";
import { createBridgeInstallation, getBridgeInstallations, revokeBridgeInstallationKey, rotateBridgeInstallationKey } from "@/lib/bridge-installations";
import type { BridgeInstallationSummary } from "@/lib/bridge-credentials.server";

export function BridgeInstallationSettings({ orgId }: { orgId: string }) {
  return <InstallationSettings key={orgId} orgId={orgId} />;
}

function InstallationSettings({ orgId }: { orgId: string }) {
  const [installations, setInstallations] = useState<BridgeInstallationSummary[]>([]);
  const [selection, setSelection] = useState<Awaited<ReturnType<typeof getBridgeSelection>>>({ activeInstallation: null, connections: [] });
  const [takeover, setTakeover] = useState<BridgeInstallationSummary | null>(null);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{ key: string; previousKeysExpireAt?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeOrg = useRef<string | null>(orgId);
  useEffect(() => {
    activeOrg.current = orgId;
    setIssued(null); setInstallations([]); setError(null); setNotice(null); setLoading(true); setBusy(false);
    void Promise.all([getBridgeInstallations({ data: { orgId } }), getBridgeSelection({ data: { orgId } })])
      .then(([items, selected]) => { if (activeOrg.current === orgId) { setInstallations(items); setSelection(selected); } })
      .catch((cause) => { if (activeOrg.current === orgId) setError(cause instanceof Error ? cause.message : "Could not load Bridge installations."); })
      .finally(() => { if (activeOrg.current === orgId) setLoading(false); });
    return () => { activeOrg.current = null; };
  }, [orgId]);

  async function change(action: "create" | "rotate" | "revoke", installationId?: string) {
    if (busy || (action === "create" && !label.trim())) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (action === "create") {
        const created = await createBridgeInstallation({ data: { orgId, label: label.trim() } });
        if (activeOrg.current !== orgId) return;
        setIssued(created); setLabel("");
      } else if (installationId) {
        if (action === "rotate") {
          const rotated = await rotateBridgeInstallationKey({ data: { orgId, installationId } });
          if (activeOrg.current !== orgId) return;
          setIssued(rotated);
          if (!rotated.connectionUpdated) setNotice("Key rotated. Connection status will refresh when the Bridge next communicates.");
        } else {
          const revoked = await revokeBridgeInstallationKey({ data: { orgId, installationId } });
          if (activeOrg.current !== orgId) return;
          setIssued(null);
          setNotice(revoked.connectionUpdated ? "Installation revoked and disconnected." : "Installation revoked. Further commands are blocked; connection status will refresh on its next message.");
        }
      }
      const [items, selected] = await Promise.all([getBridgeInstallations({ data: { orgId } }), getBridgeSelection({ data: { orgId } })]);
      if (activeOrg.current === orgId) { setInstallations(items); setSelection(selected); }
    } catch (cause) {
      if (activeOrg.current === orgId) setError(cause instanceof Error ? cause.message : "Bridge credential change failed.");
    } finally { if (activeOrg.current === orgId) setBusy(false); }
  }

  async function refreshSelection() {
    setBusy(true); setError(null);
    try {
      const selected = await getBridgeSelection({ data: { orgId } });
      if (activeOrg.current === orgId) setSelection(selected);
    } catch (cause) { if (activeOrg.current === orgId) setError(cause instanceof Error ? cause.message : "Could not refresh Bridge status."); }
    finally { if (activeOrg.current === orgId) setBusy(false); }
  }

  async function confirmTakeover() {
    if (!takeover || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const selected = await takeBridgeControl({ data: { orgId, installationId: takeover.id, expectedActiveInstallationId: selection.activeInstallation?.installationId ?? null, confirmed: true } });
      if (activeOrg.current === orgId) { setSelection(selected); setNotice(`${takeover.label} now controls venue devices.`); }
    } catch (cause) { if (activeOrg.current === orgId) setError(cause instanceof Error ? cause.message : "Bridge takeover was not confirmed."); }
    finally { if (activeOrg.current === orgId) { setBusy(false); setTakeover(null); } }
  }

  return <section className="space-y-4 rounded-xl border border-board-border bg-board-card p-4">
    <div><h3 className="text-sm font-semibold text-board-text">Bridge installations</h3><p className="mt-1 text-xs text-board-muted">Give each computer its own key. Only the active Bridge controls venue devices. A standby never takes over automatically.</p></div>
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-board-border p-3">
      <p role="status" className="text-sm text-board-text">{selection.activeInstallation
        ? `Active: ${selection.activeInstallation.label}${selection.connections.some(connection => connection.role === "active") ? " · Connected" : " · Offline. Choose a connected standby to take control."}`
        : "No active Bridge. The first installation to connect becomes active."}</p>
      <button type="button" disabled={busy} onClick={() => { void refreshSelection(); }} className="min-h-11 rounded-lg border border-board-border px-3 text-xs text-board-text disabled:opacity-40">Refresh status</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-amber-200">{notice}</p>}
    {issued && <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm text-amber-200">Copy this key into the Bridge now. It is shown only here and cannot be retrieved later.</p>
      <code className="block break-all rounded bg-board-bg p-3 text-xs text-board-text">{issued.key}</code>
      {issued.previousKeysExpireAt && <p className="text-xs text-board-muted">Previous keys remain valid for up to 10 minutes so you can update the Bridge without interrupting it.</p>}
      <button type="button" onClick={() => { void navigator.clipboard.writeText(issued.key).then(() => setNotice("Bridge key copied.")).catch(() => setError("Copy failed. Select and copy the key above.")); }} className="min-h-11 rounded-lg border border-board-border px-3 text-xs text-board-text">Copy key</button>
      <button type="button" onClick={() => setIssued(null)} className="ml-2 min-h-11 rounded-lg px-3 text-xs text-board-muted">Dismiss key</button>
    </div>}
    <form onSubmit={(event) => { event.preventDefault(); void change("create"); }} className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-xs text-board-muted">Installation name<input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Main room computer" className="mt-1 block min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text" /></label>
      <button disabled={busy || !label.trim()} className="min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text disabled:opacity-40">Create key</button>
    </form>
    {loading ? <p className="text-xs text-board-muted">Loading installations…</p> : installations.length === 0 ? <p className="text-xs text-board-muted">No Bridge installations yet.</p> : <ul className="divide-y divide-board-border">
      {installations.map((installation) => <li key={installation.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0"><p className="break-words text-sm text-board-text">{installation.label}</p><p className="text-xs text-board-muted">{selection.connections.find(connection => connection.installationId === installation.id)?.role === "active" ? "Active · Connected" : selection.connections.some(connection => connection.installationId === installation.id) ? "Standby · Connected" : "Offline"}</p><p className="text-xs text-board-muted">{installation.revokedAt !== null ? "Revoked" : installation.lastUsedAt !== null ? `Last used ${new Date(installation.lastUsedAt).toLocaleString()}` : "Not connected yet"}</p></div>
        {installation.revokedAt === null && <div className="flex gap-2">
          {selection.connections.some(connection => connection.installationId === installation.id && connection.role === "standby") && <button type="button" disabled={busy} onClick={() => setTakeover(installation)} className="min-h-11 rounded-lg border border-amber-500/40 px-3 text-xs text-amber-200 disabled:opacity-40">Take control</button>}
          <button type="button" disabled={busy} onClick={() => { void change("rotate", installation.id); }} className="min-h-11 rounded-lg border border-board-border px-3 text-xs text-board-text disabled:opacity-40">Rotate key</button>
          <button type="button" disabled={busy} onClick={() => { void change("revoke", installation.id); }} className="min-h-11 rounded-lg border border-red-500/30 px-3 text-xs text-red-300 disabled:opacity-40">Revoke</button>
        </div>}
      </li>)}
    </ul>}
    <ConfirmDialog open={takeover !== null} onOpenChange={open => { if (!open && !busy) setTakeover(null); }} title={`Use ${takeover?.label ?? "this Bridge"} for venue devices?`}
      description={`This stops device output on ${selection.activeInstallation?.label ?? "the previous Bridge"} before activating the selected computer. Check any in-flight device commands before retrying them.`}
      confirmLabel="Take control" variant="warning" loading={busy} onConfirm={() => { void confirmTakeover(); }} />
  </section>;
}
