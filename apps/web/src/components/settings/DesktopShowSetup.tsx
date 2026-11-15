import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { useDesktopBridgeStatus } from "@/hooks/useDesktopBridgeStatus";
import { useRundownSync } from "@/hooks/useRundownSync";
import { getDesktopActions, desktopOperationPending } from "@/lib/desktop-operations";
import { configureDesktopLocalDevices } from "@/lib/desktop-local-devices";
import { stopDesktopBridge, openDesktopLocalShow, isDesktopLocalDeviceMode } from "@/lib/desktop-runtime";
import { getRundownOpeningDate } from "@/lib/rundown";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { OfflineShowPreparation } from "@/components/settings/OfflineShowPreparation";
import { Button } from "@/components/ui/button";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

/** Setup controls stay off the operator's rundown, with the same native APIs. */
export function DesktopShowSetup({ orgId, slug }: { orgId: string; slug: string }) {
  const desktop = useDesktopRuntime();
  if (!desktop) return null;
  return <Setup key={`${orgId}:${slug}`} orgId={orgId} slug={slug} />;
}
function Setup({ orgId, slug }: { orgId: string; slug: string }) {
  const bridge = useDesktopBridgeStatus(true);
  const actions = getDesktopActions();
  const bridgeAction = useSyncExternalStore(actions.bridge.subscribe, actions.bridge.getSnapshot, actions.bridge.getSnapshot);
  const localAction = useSyncExternalStore(actions.localShow.subscribe, actions.localShow.getSnapshot, actions.localShow.getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const confirmation = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [prepare, setPrepare] = useState(false);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const busy = confirming || desktopOperationPending(bridgeAction) || desktopOperationPending(localAction);
  const error = bridge.error || bridgeAction.kind === "failed" || bridgeAction.kind === "unconfirmed" || localAction.kind === "failed" || localAction.kind === "unconfirmed";
  const choose = async (enabled: boolean) => {
    if (busy || confirmation.current || !alive.current) return;
    confirmation.current = true; setConfirming(true);
    try {
      const approved = await confirm({
        title: enabled ? "Use this computer for local devices?" : "Use the venue Bridge?",
        description: enabled ? "Use the computer connected to your equipment network. Choose the active venue Bridge in Settings before starting the show." : "This stops device output from this computer. Make sure the venue Bridge is ready.",
        confirmLabel: enabled ? "Use this computer" : "Use venue Bridge", variant: "warning",
      });
      if (!approved || !alive.current) return;
      actions.bridge.start("Local device change", async withinDeadline => {
        if (!alive.current || !withinDeadline()) return;
        if (enabled) await configureDesktopLocalDevices(slug, true, () => alive.current && withinDeadline());
        else await stopDesktopBridge();
      });
    } finally { confirmation.current = false; if (alive.current) setConfirming(false); }
  };
  useEffect(() => { if (bridgeAction.kind === "complete" || bridgeAction.kind === "failed") bridge.refresh(); }, [bridgeAction, bridge.refresh]);
  const enabled = isDesktopLocalDeviceMode(bridge.status);
  return <section aria-label="This computer setup" className="space-y-3 rounded-xl border border-board-border bg-board-card p-4">
    <h2 className="font-semibold">This computer</h2>
    <p className="text-sm text-board-muted">Choose where equipment is connected before starting a show.</p>
    <div role="group" aria-label="Equipment computer" className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy || !bridge.status} aria-pressed={!enabled} onClick={() => void choose(false)}>Venue Bridge</Button>
      <Button variant="outline" disabled={busy || !bridge.status} aria-pressed={enabled} onClick={() => void choose(true)}>Use this computer</Button>
    </div>
    {busy || !bridge.status && !bridge.error ? <QuietActivity /> : null}
    {error || bridge.error ? <div role="alert" className="text-sm text-red-400"><p>This computer could not be set up.</p><Button variant="outline" onClick={bridge.refresh}>Retry</Button></div> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => actions.localShow.start("Local show", openDesktopLocalShow)}>Open saved show</Button>
      <Button variant="outline" disabled={busy || !enabled} onClick={() => setPrepare(value => !value)} aria-expanded={prepare}>Prepare offline show</Button>
    </div>
    {prepare && <Preparation orgId={orgId} slug={slug} />}
    {ConfirmDialogEl}
  </section>;
}
function Preparation({ orgId, slug }: { orgId: string; slug: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const choices = useQuery({ queryKey: ["desktop-show-setup", orgId], queryFn: ({ signal }) => getRundownOpeningDate({ data: { orgId, today: new Date().toISOString().slice(0, 10) }, signal }), retry: false });
  if (choices.isError) return <div role="alert" className="text-sm text-red-400"><p>Shows could not be loaded.</p><Button variant="outline" onClick={() => void choices.refetch()}>Retry</Button></div>;
  if (!choices.data) return <QuietActivity />;
  const selected = choices.data.shows.find(show => show.id === (selectedId ?? choices.data.showId));
  return <div className="space-y-3">
    <label className="block text-sm">Show
      <select className="mt-1 min-h-11 w-full rounded-md border border-board-border bg-board-bg px-3" value={selected?.id ?? ""} onChange={event => setSelectedId(event.target.value)}>
        <option value="" disabled>Choose a show</option>
        {choices.data.shows.map(show => <option key={show.id} value={show.id}>{show.name} · {show.serviceDate}</option>)}
      </select>
    </label>
    {selected && <PreparedShow key={`${orgId}:${selected.id}:${selected.serviceDate}`} orgId={orgId} slug={slug} showId={selected.id} serviceDate={selected.serviceDate} />}
  </div>;
}

function PreparedShow(props: { orgId: string; slug: string; showId: string; serviceDate: string }) {
  const context = useRouteContext({ from: "/$slug" });
  const cloud = useRundownSync(props.orgId, props.serviceDate, props.showId);
  const canControl = hasEffectivePermission(context.role, context.grantedPermissions, "rundown:control");
  return <OfflineShowPreparation {...props} cloudRevision={cloud.revision} cloudReady={cloud.connected && cloud.hydrated && cloud.stateInitialized && cloud.stateShowId === props.showId && cloud.stateServiceDate === props.serviceDate && !cloud.saving && !cloud.hasPendingCommands() && !cloud.lastError} canControl={canControl} canPrepare={canControl && hasEffectivePermission(context.role, context.grantedPermissions, "devices:access") && hasEffectivePermission(context.role, context.grantedPermissions, "timecode:access")} />;
}
