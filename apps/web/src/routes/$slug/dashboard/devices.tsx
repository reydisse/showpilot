import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useMemo, useState } from "react";
import {
  Clock,
  Radio,
  Activity,
  Home,
  Monitor,
  MessageSquare,
  Lightbulb,
  Plus,
  Trash2,
  Wifi,
  Search,
  Settings2,
  Server,
  Power,
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

export const Route = createFileRoute("/$slug/dashboard/devices")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "devices:access", context.slug, context.orgId);
    const devices = await getDevices({ data: { orgId: context.orgId } });
    return { devices, orgId: context.orgId, slug: context.slug };
  },
  component: DevicesPage,
});

function DevicesPage() {
  const { devices, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editDevice, setEditDevice] = useState<typeof devices[0] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => devices[0]?.id ?? null);
  const [controlsDeviceId, setControlsDeviceId] = useState<string | null>(null);
  const selectedDevice = devices.find((device) => device.id === selectedId) ?? devices[0] ?? null;
  const filteredDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) => `${device.name} ${device.adapterType} ${device.category}`.toLowerCase().includes(needle));
  }, [devices, query]);
  const enabledCount = devices.filter((device) => device.enabled).length;
  const protocolCount = new Set(devices.map((device) => device.adapterType)).size;

  const handleToggleEnabled = async (id: string, currentEnabled: boolean) => {
    await updateDevice({ data: { orgId, id, updates: { enabled: !currentEnabled } } });
    router.invalidate();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteDevice({ data: { orgId, id: deleteTarget.id } });
    setDeleting(false);
    setDeleteTarget(null);
    router.invalidate();
  };

  const openControls = (deviceId: string) => setControlsDeviceId(deviceId);

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Devices
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Manage connected devices and integrations
            </p>
          </div>
          <button
            onClick={() => {
              setEditDevice(null);
              setShowForm(true);
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-fire-500 text-white text-sm font-semibold hover:bg-fire-600 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Device
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-[1500px] p-4 md:p-6">
        {devices.length === 0 ? (
          <EmptyState
            icon={Monitor}
            title="No devices registered"
            description="Register your ProPresenter, OBS, mixers and other production devices to monitor and control them from here."
            action={
              <EmptyStateButton
                onClick={() => {
                  setEditDevice(null);
                  setShowForm(true);
                }}
              >
                Add Device
              </EmptyStateButton>
            }
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 divide-x divide-board-border overflow-hidden rounded-xl border border-board-border bg-board-card">
              <FleetStat label="Configured" value={devices.length} icon={Server} />
              <FleetStat label="Enabled" value={enabledCount} icon={Wifi} tone="text-green-400" />
              <FleetStat label="Protocols" value={protocolCount} icon={Activity} />
            </div>
            <div className="grid min-h-[580px] overflow-hidden rounded-xl border border-board-border bg-board-card lg:grid-cols-[320px_minmax(0,1fr)_280px]">
              <aside className="border-b border-board-border lg:border-b-0 lg:border-r">
                <div className="border-b border-board-border p-3"><label className="relative block"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-board-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search devices" className="w-full rounded-lg border border-board-border bg-board-bg py-2 pl-9 pr-3 text-xs text-board-text outline-none focus:border-fire-500/50" /></label></div>
                <div className="max-h-[520px] overflow-auto py-1">
                  {filteredDevices.map((device) => { const Icon = CATEGORY_ICONS[device.category as DeviceCategory] ?? Monitor; return <button type="button" key={device.id} onClick={() => { setSelectedId(device.id); setControlsDeviceId(null); }} className={`flex w-full items-center gap-3 border-l-2 px-3 py-3 text-left transition-colors ${selectedDevice?.id === device.id ? "border-fire-500 bg-fire-500/[0.06]" : "border-transparent hover:bg-board-bg/60"}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-board-bg"><Icon className={`h-4 w-4 ${device.enabled ? "text-board-text" : "text-board-muted"}`} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-board-text">{device.name}</span><span className="mt-0.5 block truncate text-[10px] text-board-muted">{getAdapterLabel(device.adapterType)}</span></span><span className={`h-2 w-2 shrink-0 rounded-full ${device.enabled ? "bg-green-500" : "bg-board-muted/40"}`} /></button>; })}
                </div>
              </aside>

              {selectedDevice ? <main className="min-w-0 border-b border-board-border lg:border-b-0 lg:border-r">
                <div className="flex flex-wrap items-center gap-3 border-b border-board-border px-5 py-4"><div className="min-w-0 flex-1"><h2 className="truncate text-base font-semibold text-board-text">{selectedDevice.name}</h2><p className="mt-0.5 text-xs text-board-muted">{getAdapterLabel(selectedDevice.adapterType)} · {CATEGORY_LABELS[selectedDevice.category as DeviceCategory] ?? selectedDevice.category}</p></div>{controlsDeviceId === selectedDevice.id ? <button type="button" onClick={() => setControlsDeviceId(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-board-border px-3 py-2 text-xs font-semibold text-board-text hover:bg-board-bg"><X className="h-3.5 w-3.5" /> Close controls</button> : <button type="button" onClick={() => openControls(selectedDevice.id)} className="inline-flex items-center gap-1.5 rounded-lg bg-fire-500 px-3 py-2 text-xs font-semibold text-black hover:bg-fire-400">Open controls <Activity className="h-3.5 w-3.5" /></button>}</div>
                {controlsDeviceId === selectedDevice.id ? <InlineDeviceControls device={selectedDevice} orgId={orgId} /> : <div className="p-5"><div className="rounded-xl border border-board-border bg-board-bg/45 p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-wider text-board-muted">Control readiness</p><p className={`mt-2 flex items-center gap-2 text-sm font-medium ${selectedDevice.enabled ? "text-green-400" : "text-board-muted"}`}><span className={`h-2 w-2 rounded-full ${selectedDevice.enabled ? "bg-green-500" : "bg-board-muted/40"}`} />{selectedDevice.enabled ? "Enabled — open controls to connect" : "Device disabled"}</p></div><Power className="h-5 w-5 text-board-muted" /></div><p className="mt-3 text-xs leading-5 text-board-muted">Connection state is verified inside the control workspace. ShowPilot will not claim a device is online until its adapter completes a connection.</p></div><div className="mt-5"><h3 className="text-xs font-semibold text-board-text">Available workflow</h3><div className="mt-3 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => openControls(selectedDevice.id)} className="rounded-xl border border-board-border p-4 text-left hover:border-fire-500/30"><Activity className="h-4 w-4 text-fire-500" /><p className="mt-3 text-xs font-semibold text-board-text">Protocol controls</p><p className="mt-1 text-[11px] leading-5 text-board-muted">Connect the adapter, inspect feedback and run commands supported by this device.</p></button><button type="button" onClick={() => { setEditDevice(selectedDevice); setShowForm(true); }} className="rounded-xl border border-board-border p-4 text-left hover:border-fire-500/30"><Settings2 className="h-4 w-4 text-board-muted" /><p className="mt-3 text-xs font-semibold text-board-text">Configuration</p><p className="mt-1 text-[11px] leading-5 text-board-muted">Update the endpoint, authentication and adapter-specific settings.</p></button></div></div></div>}
              </main> : null}

              {selectedDevice ? <aside className="p-4"><p className="text-xs font-semibold text-board-text">Device inspector</p><div className="mt-4 space-y-4"><InspectorRow label="Status" value={selectedDevice.enabled ? "Enabled" : "Disabled"} /><InspectorRow label="Adapter" value={getAdapterLabel(selectedDevice.adapterType)} /><InspectorRow label="Category" value={CATEGORY_LABELS[selectedDevice.category as DeviceCategory] ?? selectedDevice.category} />{getSafeDeviceDetails(selectedDevice.settings).map(([label, value]) => <InspectorRow key={label} label={label} value={value} />)}</div><div className="mt-6 grid gap-2"><button type="button" onClick={() => void handleToggleEnabled(selectedDevice.id, selectedDevice.enabled)} className="rounded-lg border border-board-border px-3 py-2 text-xs font-medium text-board-text hover:bg-board-bg">{selectedDevice.enabled ? "Disable device" : "Enable device"}</button><button type="button" onClick={() => { setEditDevice(selectedDevice); setShowForm(true); }} className="rounded-lg border border-board-border px-3 py-2 text-xs font-medium text-board-text hover:bg-board-bg">Edit configuration</button><button type="button" onClick={() => setDeleteTarget({ id: selectedDevice.id, name: selectedDevice.name })} className="rounded-lg px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10">Remove device</button></div></aside> : null}
            </div>
          </div>
        )}
      </div>

      {/* Add/Edit modal */}
      {showForm && (
        <DeviceFormModal
          existing={editDevice}
          orgId={orgId}
          onClose={() => {
            setShowForm(false);
            setEditDevice(null);
          }}
          onSaved={() => {
            setShowForm(false);
            setEditDevice(null);
            router.invalidate();
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-500/10">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <h3 className="text-base font-semibold text-board-text">
                Remove Device
              </h3>
            </div>
            <p className="text-sm text-board-muted mb-1">
              Are you sure you want to remove{" "}
              <span className="font-medium text-board-text">
                {deleteTarget.name}
              </span>
              ?
            </p>
            <p className="text-xs text-board-muted/60 mb-5">
              This will delete its configuration permanently.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-500 text-white font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {deleting ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineDeviceControls({ device, orgId }: { device: Awaited<ReturnType<typeof getDevices>>[number]; orgId: string }) {
  const { module, status, feedbacks, definition, connect, disconnect, error } = useDeviceModule(device, orgId);
  return <div className="max-h-[520px] overflow-auto p-5"><div className="mb-4 flex flex-wrap items-center gap-2"><span className={`h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500" : status === "connecting" ? "animate-pulse bg-yellow-400" : status === "error" ? "bg-red-500" : "bg-board-muted/40"}`} /><span className="text-xs font-medium capitalize text-board-text">{status.replace("-", " ")}</span>{status === "connected" ? <button type="button" onClick={disconnect} className="ml-auto rounded-lg border border-board-border px-3 py-1.5 text-xs text-board-muted hover:text-red-400">Disconnect</button> : status !== "connecting" ? <button type="button" onClick={() => void connect()} className="ml-auto rounded-lg border border-fire-500/30 bg-fire-500/10 px-3 py-1.5 text-xs font-semibold text-fire-400">Retry connection</button> : null}</div>{error ? <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2.5 text-xs leading-5 text-red-300">{error}</div> : null}<DeviceControlPanel module={module} status={status} feedbacks={feedbacks} definition={definition} device={device} /></div>;
}

function FleetStat({ label, value, icon: Icon, tone = "text-board-text" }: { label: string; value: number; icon: React.ElementType; tone?: string }) {
  return <div className="flex items-center gap-3 px-4 py-3"><Icon className="h-4 w-4 text-board-muted" /><div><p className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</p><p className="text-[10px] text-board-muted">{label}</p></div></div>;
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-board-border/60 pb-3 last:border-0"><p className="text-[10px] text-board-muted">{label}</p><p className="mt-1 break-all text-xs text-board-text">{value}</p></div>;
}

function DeviceFormModal({
  existing,
  orgId,
  onClose,
  onSaved,
}: {
  existing: Awaited<ReturnType<typeof getDevices>>[0] | null;
  orgId: string;
  onClose: () => void;
  onSaved: () => void;
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
      Object.entries(existingSettings).map(([k, v]) => [k, String(v)])
    )
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const adapterMeta = adapterOptions.find((a) => a.value === adapterType);
  const fields = adapterMeta?.fields ?? [];

  const handleAdapterChange = (newType: string) => {
    setAdapterType(newType);
    setSettingsMap({});
    if (!name) {
      const meta = adapterOptions.find((a) => a.value === newType);
      if (meta) setName(meta.label);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Device name is required.");
      return;
    }
    setSaving(true);
    setError("");

    const settings: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = settingsMap[field.key] ?? "";
      if (field.type === "number") {
        settings[field.key] = raw ? parseInt(raw, 10) : 0;
      } else if (raw) {
        settings[field.key] = raw;
      }
    }

    const category = adapterMeta?.category ?? "video";

    if (existing) {
      await updateDevice({
        data: {
          orgId,
          id: existing.id,
          updates: {
            name: name.trim(),
            category,
            adapterType,
            settings: JSON.stringify(settings),
            enabled,
          },
        },
      });
    } else {
      await addDevice({
        data: {
          orgId,
          name: name.trim(),
          category,
          adapterType,
          settings: JSON.stringify(settings),
          enabled,
        },
      });
    }

    setSaving(false);
    onSaved();
  };

  const INPUT_CLASS =
    "w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-board-text">
            {existing ? "Edit Device" : "Add Device"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close device editor"
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Device Type
            </label>
            <select
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
            <label className="block text-sm text-board-muted mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={adapterMeta?.label ?? "Device name"}
              className={INPUT_CLASS}
            />
          </div>

          {fields.length > 0 && (
            <div className="space-y-3 pt-1">
              <p className="text-[10px] font-medium text-board-muted/50 uppercase tracking-widest">
                Connection Settings
              </p>
              {fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm text-board-muted mb-1.5">
                    {field.label}
                  </label>
                  {field.type === "select" && field.options ? (
                    <select
                      value={settingsMap[field.key] ?? field.options[0]?.value ?? ""}
                      onChange={(e) =>
                        setSettingsMap({ ...settingsMap, [field.key]: e.target.value })
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
                    <input
                      type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                      value={settingsMap[field.key] ?? ""}
                      onChange={(e) =>
                        setSettingsMap({ ...settingsMap, [field.key]: e.target.value })
                      }
                      placeholder={field.placeholder}
                      className={INPUT_CLASS}
                    />
                  )}
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

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-board-border accent-fire-500"
            />
            <span className="text-sm text-board-text">Enable immediately</span>
          </label>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : existing ? "Update" : "Add Device"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
