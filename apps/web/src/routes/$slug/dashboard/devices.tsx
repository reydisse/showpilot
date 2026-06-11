import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState } from "react";
import {
  Clock,
  Radio,
  Activity,
  Home,
  Monitor,
  MessageSquare,
  Lightbulb,
  Plus,
  Pencil,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { getDevices, addDevice, updateDevice, deleteDevice } from "@/lib/data";
import { moduleRegistry } from "@/lib/device-modules/registry";

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
  const { devices, orgId, slug } = Route.useLoaderData();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editDevice, setEditDevice] = useState<typeof devices[0] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

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

      <div className="p-6 max-w-4xl mx-auto">
        {devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-board-border p-12 text-center">
            <Monitor className="w-10 h-10 text-board-muted/20 mx-auto mb-3" />
            <p className="text-sm font-medium text-board-muted mb-1">
              No devices registered
            </p>
            <p className="text-xs text-board-muted/50 mb-4">
              Add a device to start managing it
            </p>
            <button
              onClick={() => {
                setEditDevice(null);
                setShowForm(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-fire-500 text-white text-sm font-semibold hover:bg-fire-600 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Device
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {devices.map((device) => {
              const CategoryIcon =
                CATEGORY_ICONS[device.category as DeviceCategory] ?? Monitor;
              return (
                <div
                  key={device.id}
                  className={`rounded-xl border p-5 ${
                    device.enabled
                      ? "bg-board-card border-board-border"
                      : "bg-board-card/50 border-board-border/50 opacity-60"
                  }`}
                >
                  <Link
                    to="/$slug/dashboard/devices/$deviceId"
                    params={{ slug, deviceId: device.id }}
                    className="block mb-3 group cursor-pointer"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <CategoryIcon className="w-5 h-5 text-board-muted group-hover:text-fire-500 transition-colors" />
                        <div>
                          <p className="text-sm font-semibold text-board-text group-hover:text-fire-500 transition-colors">
                            {device.name}
                          </p>
                          <p className="text-[10px] text-board-muted uppercase tracking-wide">
                            {CATEGORY_LABELS[device.category as DeviceCategory] ?? device.category}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-[9px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                          device.enabled
                            ? "bg-board-border/50 text-board-muted border-board-border"
                            : "bg-red-500/15 text-red-400 border-red-500/25"
                        }`}
                      >
                        {device.enabled ? "Ready" : "Disabled"}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {device.enabled ? (
                        <Wifi className="w-3.5 h-3.5 text-board-muted" />
                      ) : (
                        <WifiOff className="w-3.5 h-3.5 text-red-400" />
                      )}
                        <span className="text-xs text-board-muted">
                          {device.adapterType
                          ? getAdapterLabel(device.adapterType)
                           : "No adapter"}
                        </span>
                    </div>
                  </Link>

                  <div className="flex items-center gap-1 pt-2 border-t border-board-border">
                    <button
                      onClick={() => handleToggleEnabled(device.id, device.enabled)}
                      className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors text-[10px] font-medium"
                    >
                      {device.enabled ? "Disable" : "Enable"}
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={() => {
                        setEditDevice(device);
                        setShowForm(true);
                      }}
                      title="Edit"
                      className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        setDeleteTarget({ id: device.id, name: device.name })
                      }
                      title="Delete"
                      className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
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
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            ✕
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
                <input
                  type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                  value={settingsMap[field.key] ?? ""}
                  onChange={(e) =>
                    setSettingsMap({ ...settingsMap, [field.key]: e.target.value })
                  }
                  placeholder={field.placeholder}
                  className={INPUT_CLASS}
                />
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
