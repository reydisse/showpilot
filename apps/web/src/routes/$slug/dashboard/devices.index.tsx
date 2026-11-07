import { CREDENTIAL_MASK, isCredentialField } from "@/lib/credential-fields";
import { isValidTimingMs, MAX_DEVICE_LATENCY_MS } from "@/lib/automation-timing";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { RouteError } from "@/components/ui/RouteRecovery";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { createBrowserId } from "@/lib/browser-id";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clock,
  Radio,
  Activity,
  Home,
  Monitor,
  MessageSquare,
  Lightbulb,
  LoaderCircle,
  Plus,
  Wifi,
  Search,
  Server,
  X,
} from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import { getDevices, addDevice, updateDevice, deleteDevice } from "@/lib/data";
import { moduleRegistry } from "@/lib/device-modules/registry";
import { useDeviceModule } from "@/hooks/useDeviceModule";
import { DeviceControlPanel } from "@/components/devices/DeviceControlPanel";

type DeviceCategory = "mixer" | "streaming" | "timer" | "automation" | "video" | "comms" | "lighting";

const CATEGORY_ICONS: Record<DeviceCategory, React.ElementType> = {
  timer: Clock,
  streaming: Radio,
  mixer: Activity,
  automation: Home,
  video: Monitor,
  comms: MessageSquare,
  lighting: Lightbulb,
};

const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  mixer: "Mixer",
  streaming: "Streaming",
  timer: "Timer",
  automation: "Automation",
  video: "Video",
  comms: "Comms",
  lighting: "Lighting",
};

function getAdapterOptions() {
  return moduleRegistry
    .getAll()
    .map((definition) => ({
      value: definition.adapterType,
      label: definition.displayName,
      category: definition.category as DeviceCategory,
      fields: definition.configFields,
      description: definition.description,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function getAdapterLabel(adapterType: string) {
  return moduleRegistry.get(adapterType)?.displayName ?? adapterType;
}

function getSafeDeviceDetails(settingsJson: string): Array<[string, string]> {
  try {
    const settings = JSON.parse(settingsJson) as Record<string, unknown>;
    return Object.entries(settings)
      .filter(([key, value]) => value !== "" && value !== null && !/password|secret|token|key/i.test(key))
      .slice(0, 5)
      .map(([key, value]) => [key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()), String(value)]);
  } catch {
    return [];
  }
}

export const Route = createFileRoute("/$slug/dashboard/devices/")({
  validateSearch: (search: Record<string, unknown>): { device?: string } =>
    typeof search.device === "string" && search.device.length <= 128 ? { device: search.device } : {},
  errorComponent: RouteError,
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, abortController }) => {
    const devices = await getDevices({ data: { orgId: context.orgId }, signal: abortController.signal });
    return { devices, orgId: context.orgId, slug: context.slug };
  },
  component: DevicesPage,
});

type DeviceRecord = Awaited<ReturnType<typeof getDevices>>[number];
type DeviceDraft = Pick<DeviceRecord, "name" | "category" | "adapterType" | "settings" | "enabled" | "latencyMs">;
const controlClass = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

function DevicesPage() {
  const initial = Route.useLoaderData();
  return <DevicesWorkspace key={initial.orgId} {...initial} />;
}
export function DevicesWorkspace({ devices: initialDevices, orgId, slug }: { devices: DeviceRecord[]; orgId: string; slug: string }) {
  const readDevices = useCallback((signal: AbortSignal) => getDevices({ data: { orgId }, signal }), [orgId]);
  const read = useOperatorRead({ key: orgId, initialValue: initialDevices, read: readDevices,
    errorMessage: "Could not refresh devices. Previously confirmed configuration is kept. Retry to see current devices.",
  });
  const devices = read.value;
  const writes = useConfirmedWrite(orgId);
  const writeLocked = writes.state.status !== "idle";
  const busy = writes.state.status === "saving";
  const controlsDisabled = writeLocked || !!read.error || read.refreshing;
  const [editor, setEditor] = useState<{ key: string; device: DeviceRecord | null; open: boolean } | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [query, setQuery] = useState("");
  const { device: selectedId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setSelectedId = (device: string) => void navigate({ search: { device }, replace: true });
  const selectedDevice = selectedId ? devices.find(device => device.id === selectedId) ?? null : devices[0] ?? null;
  const filteredDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return devices.filter(device => `${device.name} ${device.adapterType} ${device.category}`.toLowerCase().includes(needle));
  }, [devices, query]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const dirty = writeLocked || formDirty;
  const blocker = useBlocker({ shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname, enableBeforeUnload: dirty, withResolver: true });
  useEffect(() => { if (!dirty && blocker.status === "blocked") blocker.proceed(); }, [dirty, blocker]);
  const openEditor = (device: DeviceRecord | null) => {
    if (controlsDisabled) return;
    setFormDirty(false); setEditor({ key: createBrowserId(), device, open: true });
  };
  const closeEditor = async () => {
    if (busy) return;
    if (writeLocked) { setEditor(current => current ? { ...current, open: false } : null); return; }
    if (formDirty && !await confirm({ title: "Discard device draft?", description: "Your unsaved device fields will be discarded.", confirmLabel: "Discard draft" })) return;
    setEditor(null); setFormDirty(false);
  };
  const startChange = (label: string, write: (requestId: string, signal: AbortSignal) => Promise<unknown>, outcome: "list" | "editor" | "delete" = "list") => writes.start({
    label, write,
    finish: async (_result, signal) => {
      const confirmed = await read.refresh();
      signal.throwIfAborted();
      if (!confirmed) throw new Error("The change was saved, but the device list could not be refreshed. Retry refresh without repeating the save.");
      if (outcome === "editor") { setEditor(null); setFormDirty(false); }
      if (outcome === "delete") await navigate({ search: {}, replace: true });
    },
    apply: () => read.invalidate(),
  });
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (!await confirm({ title: "Review stored devices?", description: "The previous request may already have saved. Refresh devices before editing again. Your open configuration draft will be kept.", confirmLabel: "Review devices", variant: "warning" })) return;
    setReviewing(true);
    if (await read.refresh()) writes.discard();
    setReviewing(false);
  };
  const handleToggleEnabled = (device: DeviceRecord) => startChange(`${device.enabled ? "Disable" : "Enable"} ${device.name}`,
    (requestId, signal) => updateDevice({ data: { orgId, id: device.id, requestId, updates: { enabled: !device.enabled } }, signal }));
  const removeDevice = async (device: DeviceRecord) => {
    if (controlsDisabled || !await confirm({ title: "Remove device?", description: `Permanently remove ${device.name} and its saved connection configuration? Cues referring to this device will no longer be able to use it.`, confirmLabel: "Remove" })) return;
    await startChange(`Remove ${device.name}`, (requestId, signal) => deleteDevice({ data: { orgId, id: device.id, requestId }, signal }), "delete");
  };
  const saveDraft = (draft: DeviceDraft, clearCredentials: string[][]) => {
    if (!editor || writeLocked) return;
    const existing = editor.device;
    if (existing) void startChange(`Update ${draft.name}`, (requestId, signal) => updateDevice({ data: { orgId, id: existing.id, requestId, updates: draft, clearCredentials }, signal }), "editor");
    else void startChange(`Add ${draft.name}`, (requestId, signal) => addDevice({ data: { orgId, requestId, ...draft }, signal }), "editor");
  };
  const notice = <><ConfirmedWriteNotice collectionLabel="devices" state={writes.state} retry={() => void writes.retry()} review={() => void reviewStored()} reviewing={reviewing} />{editor?.open && read.error && <p role="alert" className="text-sm text-amber-200">{read.error.message}</p>}</>;

  return <div className="h-full min-w-0 overflow-auto">
    {ConfirmDialogEl}
    <div className="sticky top-0 z-10 border-b border-board-border bg-board-bg/95 px-4 py-4 backdrop-blur-xl sm:px-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-semibold text-board-text">Devices</h1><p className="mt-0.5 text-xs text-board-muted">Manage connected devices and integrations</p></div>{devices.length > 0 && <button disabled={controlsDisabled} onClick={() => openEditor(null)} className={`${controlClass} bg-fire-500 text-black`}><Plus className="mr-2 inline h-4 w-4" />Add Device</button>}</div></div>
    <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry devices" />
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 md:p-6">
      {!editor?.open && notice}
      {editor && !editor.open && <button className={controlClass} onClick={() => setEditor({ ...editor, open: true })}>Review device draft</button>}
      {read.refreshing && <p role="status" className="text-xs text-board-muted">Refreshing devices… Previously confirmed configuration is shown.</p>}
      {devices.length === 0 ? !read.error && !read.refreshing && <EmptyState icon={Monitor} title="No devices registered" description="Register your ProPresenter, OBS, mixers and other production devices to monitor and control them from here." action={<EmptyStateButton disabled={controlsDisabled} onClick={() => openEditor(null)}>Add Device</EmptyStateButton>} /> : <div className="space-y-4">
        <div className="hidden grid-cols-3 divide-x divide-board-border overflow-hidden rounded-xl border border-board-border bg-board-card sm:grid"><FleetStat label="Configured" value={devices.length} icon={Server} /><FleetStat label="Enabled" value={devices.filter(device => device.enabled).length} icon={Wifi} tone="text-green-400" /><FleetStat label="Protocols" value={new Set(devices.map(device => device.adapterType)).size} icon={Activity} /></div>
        <div className="grid min-w-0 overflow-hidden rounded-xl border border-board-border bg-board-card lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 border-b border-board-border lg:row-span-2 lg:border-b-0 lg:border-r">
            <div className="border-b border-board-border p-3"><label className="relative block"><span className="sr-only">Search devices</span><Search className="absolute left-3 top-4 h-3.5 w-3.5 text-board-muted" /><input aria-label="Search devices" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search devices" className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg py-2 pl-9 pr-3 text-sm text-board-text outline-none focus:border-fire-500" /></label></div>
            <div className="p-3 lg:hidden"><label htmlFor="cockpit-device" className="mb-2 block text-sm font-medium text-board-muted">Control device</label><select id="cockpit-device" disabled={!filteredDevices.length} value={filteredDevices.some(device => device.id === selectedDevice?.id) ? selectedDevice?.id : ""} onChange={event => setSelectedId(event.target.value)} className="min-h-12 w-full rounded-lg border border-board-border bg-board-bg px-3 text-base text-board-text"><option value="" disabled>{filteredDevices.length ? "Choose a matching device" : "No matching devices"}</option>{filteredDevices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></div>
            {!filteredDevices.length && <div className="space-y-3 p-3 text-sm text-board-muted"><p>No devices match your search.</p><button className={controlClass} onClick={() => setQuery("")}>Clear search</button></div>}
            <div className="hidden max-h-[70dvh] overflow-auto py-1 lg:block">{filteredDevices.map(device => { const Icon = CATEGORY_ICONS[device.category as DeviceCategory] ?? Monitor; return <button type="button" key={device.id} aria-label={`Select ${device.name}`} aria-pressed={selectedDevice?.id === device.id} onClick={() => setSelectedId(device.id)} className={`flex min-h-11 w-full items-center gap-3 border-l-2 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fire-500 ${selectedDevice?.id === device.id ? "border-fire-500 bg-fire-500/[0.06]" : "border-transparent hover:bg-board-bg/60"}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-board-bg"><Icon className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-board-text">{device.name}</span><span className="mt-0.5 block truncate text-xs text-board-muted">{getAdapterLabel(device.adapterType)}</span></span><span className={`h-2 w-2 shrink-0 rounded-full ${device.enabled ? "bg-fire-500" : "bg-board-muted/40"}`} title={device.enabled ? "Ready to connect" : "Disabled"} /></button>; })}</div>
          </aside>
          {!selectedDevice && <p role="status" className="p-5 text-sm text-board-muted">This device is no longer available. Choose a device from the list.</p>}
          {selectedDevice && <section aria-label="Selected device" className="min-w-0"><div className="border-b border-board-border px-4 py-4 sm:px-5"><h2 className="break-words text-base font-semibold text-board-text">{selectedDevice.name}</h2><p className="mt-1 text-xs text-board-muted">{getAdapterLabel(selectedDevice.adapterType)} · {CATEGORY_LABELS[selectedDevice.category as DeviceCategory] ?? selectedDevice.category}</p></div><div inert={controlsDisabled}><div className="px-4 pt-3 sm:px-5"><Link to="/$slug/dashboard/devices/$deviceId" params={{ slug, deviceId: selectedDevice.id }} className={`${controlClass} inline-flex items-center`}>Open device controls</Link></div><InlineDeviceControls key={selectedDevice.id} device={selectedDevice} orgId={orgId} /></div></section>}
          {selectedDevice && <details className="min-w-0 border-t border-board-border p-4 lg:col-start-2"><summary className="min-h-11 cursor-pointer rounded-lg py-3 text-sm font-medium text-board-text outline-none focus-visible:ring-2 focus-visible:ring-fire-500">Configuration &amp; device details</summary><div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><InspectorRow label="Status" value={selectedDevice.enabled ? "Enabled" : "Disabled"} /><InspectorRow label="Adapter" value={getAdapterLabel(selectedDevice.adapterType)} /><InspectorRow label="Category" value={CATEGORY_LABELS[selectedDevice.category as DeviceCategory] ?? selectedDevice.category} />{getSafeDeviceDetails(selectedDevice.settings).map(([label,value]) => <InspectorRow key={label} label={label} value={value} />)}</div><div className="mt-6 grid gap-2"><button disabled={controlsDisabled} className={controlClass} onClick={() => void handleToggleEnabled(selectedDevice)}>{selectedDevice.enabled ? "Disable device" : "Enable device"}</button><button disabled={controlsDisabled} className={controlClass} onClick={() => openEditor(selectedDevice)}>Edit configuration</button><button disabled={controlsDisabled} className={`${controlClass} text-red-400`} onClick={() => void removeDevice(selectedDevice)}>Remove device</button></div></details>}
        </div>
      </div>}
    </div>
    {editor && <DeviceFormModal key={editor.key} existing={editor.device} open={editor.open} locked={writeLocked} busy={busy} notice={notice} onClose={() => void closeEditor()} onSave={saveDraft} onDirty={setFormDirty} />}
    <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open && blocker.status === "blocked") blocker.reset(); }}><DialogContent aria-modal="true" showCloseButton={false} className="border-board-border bg-board-card text-board-text"><DialogTitle>Leave Devices?</DialogTitle><DialogDescription>Unsaved configuration and retry controls will be discarded. An unconfirmed request may still complete; review devices when you return.</DialogDescription><div className="flex flex-wrap gap-2"><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.reset()}>Stay</button><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.proceed()}>Leave Devices</button></div></DialogContent></Dialog>
  </div>;
}

function InlineDeviceControls({ device, orgId }: { device: Awaited<ReturnType<typeof getDevices>>[number]; orgId: string }) {
  const { module, status, feedbacks, definition, bridgeOnline, connect, disconnect, error, errorAt } = useDeviceModule(device, orgId);
  const connecting = status === "connecting";
  return <div className="min-w-0 p-3 sm:p-5"><div className="mb-4 flex flex-wrap items-center gap-2"><span className={`h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500" : connecting ? "animate-pulse bg-yellow-400" : status === "error" || status === "bridge-required" ? "bg-red-500" : "bg-board-muted/40"}`} /><span role="status" aria-live="polite" className="text-xs font-medium capitalize text-board-text">{status.replace("-", " ")}</span>{(definition?.connectivity === "bridge-required" || device.settings.includes(CREDENTIAL_MASK)) ? <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${bridgeOnline ? "border-green-500/25 bg-green-500/[0.07] text-green-400" : "border-red-500/25 bg-red-500/[0.07] text-red-300"}`}>Venue Bridge {bridgeOnline ? "online" : "offline"}</span> : null}{status === "connected" ? <button type="button" onClick={disconnect} className="ml-auto min-h-11 rounded-lg border border-board-border px-3 py-1.5 text-xs text-board-muted hover:text-red-400">Disconnect</button> : status !== "bridge-required" ? <button type="button" onClick={() => void connect()} disabled={connecting || !module} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-fire-500/30 bg-fire-500/10 px-3 py-1.5 text-xs font-semibold text-fire-400 disabled:cursor-wait disabled:opacity-70">{connecting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}{connecting ? "Connecting..." : error ? "Retry connection" : "Connect"}</button> : null}</div>{error ? <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2.5 text-xs leading-5 text-red-300">{error} {errorAt !== null && <time dateTime={new Date(errorAt).toISOString()}>{new Date(errorAt).toLocaleTimeString()}</time>}</div> : null}<DeviceControlPanel module={module} status={status} feedbacks={feedbacks} definition={definition} device={device} /></div>;
}

function FleetStat({ label, value, icon: Icon, tone = "text-board-text" }: { label: string; value: number; icon: React.ElementType; tone?: string }) {
  return <div className="flex items-center gap-3 px-4 py-3"><Icon className="h-4 w-4 text-board-muted" /><div><p className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</p><p className="text-[10px] text-board-muted">{label}</p></div></div>;
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-board-border/60 pb-3 last:border-0"><p className="text-[10px] text-board-muted">{label}</p><p className="mt-1 break-all text-xs text-board-text">{value}</p></div>;
}

function DeviceFormModal({ existing, open, locked, busy, notice, onClose, onSave, onDirty }: {
  existing: DeviceRecord | null; open: boolean; locked: boolean; busy: boolean; notice: React.ReactNode;
  onClose: () => void; onSave: (draft: DeviceDraft, clearCredentials: string[][]) => void; onDirty: (dirty: boolean) => void;
}) {
  const existingSettings = existing
    ? (() => {
        try {
          return JSON.parse(existing.settings) as Record<string, string>;
        } catch {
          return {};
        }
      })()
    : {};

  const adapterOptions = getAdapterOptions();
  const [adapterType, setAdapterType] = useState(existing?.adapterType ?? adapterOptions[0]?.value ?? "obs");
  const [name, setName] = useState(existing?.name ?? "");
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(existingSettings).map(([k, v]) => [k, v === CREDENTIAL_MASK ? "" : String(v)])
    )
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [latencyText, setLatencyText] = useState(String(existing?.latencyMs ?? 0));
  const [clearCredentials, setClearCredentials] = useState<string[]>([]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [error, setError] = useState("");

  const adapterMeta = adapterOptions.find((a) => a.value === adapterType);
  const fields = (adapterMeta?.fields ?? []).filter(field => adapterType !== "homeassistant" || field.key !== "connectionMode");

  const handleAdapterChange = (newType: string) => {
    setAdapterType(newType);
    setSettingsMap({});
    setClearCredentials([]);
    if (!name) {
      const meta = adapterOptions.find((a) => a.value === newType);
      if (meta) setName(meta.label);
    }
  };

  const [original] = useState(() => JSON.stringify({ adapterType, name, settingsMap, enabled, latencyText, clearCredentials }));
  const dirty = JSON.stringify({ adapterType, name, settingsMap, enabled, latencyText, clearCredentials }) !== original;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    if (!name.trim()) {
      setError("Device name is required.");
      return;
    }
    const latencyMs = Number(latencyText);
    if (latencyText.trim() === "" || !isValidTimingMs(latencyMs, MAX_DEVICE_LATENCY_MS)) {
      setError(`Device latency must be a whole number from 0 to ${MAX_DEVICE_LATENCY_MS} milliseconds.`);
      return;
    }
    setError("");
    const settings: Record<string, unknown> = adapterType === "homeassistant" ? { connectionMode: "bridge-required" } : {};
    for (const field of fields) {
      const raw = settingsMap[field.key] ?? (field.type === "select" ? field.options?.[0]?.value ?? "" : "");
      if (field.type === "number") {
        // Omit optional blanks so the adapter's default is used. Port 0 is
        // not a default and is correctly rejected by destination approval.
        if (raw.trim() !== "") settings[field.key] = Number(raw);
      } else {
        settings[field.key] = raw;
      }
    }

    const category = adapterMeta?.category ?? "video";

    onSave({ name: name.trim(), category, adapterType, settings: JSON.stringify(settings), enabled, latencyMs }, clearCredentials.map(key => [key]));
  };
  const INPUT_CLASS = "min-h-11 min-w-0 w-full rounded-xl border border-board-border bg-board-bg px-4 py-2.5 text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500";
  return <><Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><DialogContent aria-modal="true" showCloseButton={false} className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text">
    <div className="flex shrink-0 items-start gap-3 border-b border-board-border p-4"><div className="min-w-0 flex-1"><DialogTitle>{existing ? "Edit Device" : "Add Device"}</DialogTitle><DialogDescription className="mt-1">Save this device's connection settings and timing.</DialogDescription></div><button type="button" disabled={busy} onClick={onClose} aria-label="Close device editor" className={`${controlClass} min-w-11`}><X className="h-4 w-4" /></button></div>
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-col"><div className="min-h-0 space-y-4 overflow-y-auto p-4">{notice}{error && <p role="alert" className="text-sm text-red-400">{error}</p>}<fieldset disabled={locked} className="min-w-0 space-y-4 disabled:opacity-60">
          <div>
            <label htmlFor="device-adapter" className="block text-sm text-board-muted mb-1.5">
              Device Type
            </label>
            <select id="device-adapter"
              value={adapterType}
              onChange={(e) => handleAdapterChange(e.target.value)}
              className={`${INPUT_CLASS} appearance-none`}
            >
              {adapterOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="device-name" className="block text-sm text-board-muted mb-1.5">
              Display Name
            </label>
            <input id="device-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={adapterMeta?.label ?? "Device name"}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="device-latency" className="block text-sm text-board-muted mb-1.5">Device latency (ms)</label>
            <input id="device-latency" type="number" min={0} max={MAX_DEVICE_LATENCY_MS} step={1} required
              value={latencyText} onChange={event => setLatencyText(event.target.value)} className={INPUT_CLASS}
              aria-describedby="device-latency-help" />
            <p id="device-latency-help" className="mt-2 text-xs text-board-muted">Send this device's timed cues early by its measured response delay. Applied when timecode starts or automation is enabled.</p>
          </div>

          {fields.length > 0 && (
            <div className="space-y-3 pt-1">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest">
                Connection Settings
              </p>
              {fields.some(field => field.type === "password" || isCredentialField(field.key)) && <p className="text-xs text-board-muted">Saved credentials are used by the venue Bridge. Keep it running to control authenticated devices.</p>}
              {fields.map((field) => (
                <div key={field.key}>
                  <label htmlFor={`device-field-${field.key}`} className="block text-sm text-board-muted mb-1.5">
                    {field.label}
                  </label>
                  {field.type === "select" && field.options ? (
                    <select id={`device-field-${field.key}`}
                      value={settingsMap[field.key] ?? field.options[0]?.value ?? ""}
                      onChange={(e) =>
                        { setSettingsMap({ ...settingsMap, [field.key]: e.target.value }); setClearCredentials(keys => keys.filter(key => key !== field.key)); }
                      }
                      className={`${INPUT_CLASS} appearance-none`}
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input id={`device-field-${field.key}`}
                      autoComplete={field.type === "password" || isCredentialField(field.key) ? "new-password" : undefined}
                      type={field.type === "password" || isCredentialField(field.key) ? "password" : field.type === "number" ? "number" : "text"}
                      value={settingsMap[field.key] ?? ""}
                      onChange={(e) =>
                        { setSettingsMap({ ...settingsMap, [field.key]: e.target.value }); setClearCredentials(keys => keys.filter(key => key !== field.key)); }
                      }
                      placeholder={existing?.adapterType === adapterType && existingSettings[field.key] === CREDENTIAL_MASK ? "Leave blank to keep saved credential" : field.placeholder}
                      className={INPUT_CLASS}
                    />
                  )}
                  {existing?.adapterType === adapterType && existingSettings[field.key] === CREDENTIAL_MASK && <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-board-muted">{clearCredentials.includes(field.key) ? "Will be cleared when you save." : "Credential saved. Leave blank to keep it."}</p>
                    <button type="button" disabled={locked} className="min-h-11 px-3 text-sm text-red-300"
                      onClick={async () => {
                        if (clearCredentials.includes(field.key)) { setClearCredentials(keys => keys.filter(key => key !== field.key)); return; }
                        if (await confirm({ title: `Clear ${field.label}?`, description: "This connection may stop working until a new credential is saved.", confirmLabel: "Clear credential" })) {
                          setSettingsMap(values => ({ ...values, [field.key]: "" }));
                          setClearCredentials(keys => [...keys, field.key]);
                        }
                      }}>{clearCredentials.includes(field.key) ? "Keep saved credential" : "Clear credential"}</button>
                  </div>}
                </div>
              ))}
            </div>
          )}

          {fields.length === 0 && (
            <p className="text-xs text-board-muted/60 px-1">
              This adapter reads its configuration from environment variables. No
              connection details needed here.
            </p>
          )}

          <label className="flex min-h-11 items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-board-border accent-fire-500"
            />
            <span className="text-sm text-board-text">Enable immediately</span>
          </label>

    </fieldset></div><div className="flex shrink-0 gap-3 border-t border-board-border p-4"><button type="button" disabled={busy} onClick={onClose} className={`${controlClass} flex-1`}>Cancel</button><button type="submit" disabled={locked} className={`${controlClass} flex-1 bg-fire-500 text-black`}>{busy ? "Saving…" : existing ? "Update" : "Add Device"}</button></div></form>
  </DialogContent></Dialog>{ConfirmDialogEl}</>;
}
