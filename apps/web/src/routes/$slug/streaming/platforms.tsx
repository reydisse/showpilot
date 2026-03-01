import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Radio,
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import {
  getStreamDestinations,
  addStreamDestination,
  updateStreamDestination,
  deleteStreamDestination,
  toggleStreamDestination,
} from "@/lib/stream-destinations";

type Platform = "youtube" | "facebook" | "twitch" | "custom";

const PLATFORM_CONFIG: Record<
  Platform,
  { label: string; color: string; defaultRtmp: string }
> = {
  youtube: {
    label: "YouTube",
    color: "bg-red-500/15 text-red-400 border-red-500/25",
    defaultRtmp: "rtmp://a.rtmp.youtube.com/live2",
  },
  facebook: {
    label: "Facebook",
    color: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    defaultRtmp: "rtmps://live-api-s.facebook.com:443/rtmp/",
  },
  twitch: {
    label: "Twitch",
    color: "bg-purple-500/15 text-purple-400 border-purple-500/25",
    defaultRtmp: "rtmp://live.twitch.tv/app",
  },
  custom: {
    label: "Custom RTMP",
    color: "bg-board-border text-board-muted border-board-border",
    defaultRtmp: "",
  },
};

export const Route = createFileRoute("/$slug/streaming/platforms")({
  loader: async ({ context }) => {
    const destinations = await getStreamDestinations({
      data: { orgId: context.orgId },
    });
    return { destinations, orgId: context.orgId };
  },
  component: PlatformsPage,
});

function PlatformsPage() {
  const { destinations, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editDest, setEditDest] = useState<typeof destinations[0] | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  const activeCount = destinations.filter((d) => d.enabled).length;

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    await toggleStreamDestination({ data: { id, enabled: !currentEnabled } });
    router.invalidate();
  };

  const handleDelete = async (id: string) => {
    await deleteStreamDestination({ data: { id } });
    router.invalidate();
  };

  const toggleKeyVisibility = (id: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Multi-Platform
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Manage streaming destinations
            </p>
          </div>
          <button
            onClick={() => {
              setEditDest(null);
              setShowForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Destination
          </button>
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto space-y-5">
        {/* Summary */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-fire-500" />
            <span className="text-sm font-medium text-board-text">
              {destinations.length} destination{destinations.length !== 1 ? "s" : ""}
            </span>
          </div>
          <span className="text-xs text-board-muted">
            {activeCount} active
          </span>
        </div>

        {/* Destinations list */}
        {destinations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-board-border p-12 text-center">
            <Radio className="w-10 h-10 text-board-muted/20 mx-auto mb-3" />
            <p className="text-sm font-medium text-board-muted mb-1">
              No streaming destinations
            </p>
            <p className="text-xs text-board-muted/50 mb-4">
              Add YouTube, Facebook, Twitch, or custom RTMP destinations
            </p>
            <button
              onClick={() => {
                setEditDest(null);
                setShowForm(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-fire-500 text-white text-sm font-semibold hover:bg-fire-600 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Destination
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {destinations.map((dest) => {
              const platformCfg =
                PLATFORM_CONFIG[dest.platform as Platform] ?? PLATFORM_CONFIG.custom;
              const keyRevealed = revealedKeys.has(dest.id);

              return (
                <div
                  key={dest.id}
                  className={`rounded-xl border p-5 transition-all ${
                    dest.enabled
                      ? "bg-board-card border-board-border"
                      : "bg-board-card/50 border-board-border/50 opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border ${platformCfg.color}`}
                      >
                        {platformCfg.label}
                      </span>
                      <p className="text-sm font-semibold text-board-text">
                        {dest.name}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleToggle(dest.id, dest.enabled)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          dest.enabled
                            ? "text-green-400 hover:bg-green-500/10"
                            : "text-board-muted hover:bg-board-border/50"
                        }`}
                        title={dest.enabled ? "Disable" : "Enable"}
                      >
                        {dest.enabled ? (
                          <ToggleRight className="w-5 h-5" />
                        ) : (
                          <ToggleLeft className="w-5 h-5" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setEditDest(dest);
                          setShowForm(true);
                        }}
                        className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(dest.id)}
                        className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {dest.rtmpUrl && (
                    <p className="text-[11px] text-board-muted font-mono truncate mb-1">
                      {dest.rtmpUrl}
                    </p>
                  )}

                  {dest.streamKey && (
                    <div className="flex items-center gap-2">
                      <code className="text-[11px] text-board-muted/60 font-mono truncate">
                        {keyRevealed ? dest.streamKey : "••••••••••••••••"}
                      </code>
                      <button
                        onClick={() => toggleKeyVisibility(dest.id)}
                        className="p-1 rounded text-board-muted hover:text-board-text transition-colors"
                      >
                        {keyRevealed ? (
                          <EyeOff className="w-3 h-3" />
                        ) : (
                          <Eye className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Info */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-2">
            Multi-Streaming
          </p>
          <div className="space-y-1.5 text-xs text-board-muted">
            <p>
              Add your streaming platform credentials here. When connected to a
              Cloudflare Stream live input, enabled destinations receive the
              stream via Stream Connect (simulcasting).
            </p>
            <p>
              Configure live inputs on the Stream Health page first.
            </p>
          </div>
        </div>

        {/* Add/Edit form modal */}
        {showForm && (
          <DestinationFormModal
            existing={editDest}
            orgId={orgId}
            onClose={() => {
              setShowForm(false);
              setEditDest(null);
            }}
            onSaved={() => {
              setShowForm(false);
              setEditDest(null);
              router.invalidate();
            }}
          />
        )}
      </div>
    </div>
  );
}

function DestinationFormModal({
  existing,
  orgId,
  onClose,
  onSaved,
}: {
  existing: Awaited<ReturnType<typeof getStreamDestinations>>[0] | null;
  orgId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [platform, setPlatform] = useState<Platform>(
    (existing?.platform as Platform) ?? "youtube"
  );
  const [rtmpUrl, setRtmpUrl] = useState(
    existing?.rtmpUrl ?? PLATFORM_CONFIG.youtube.defaultRtmp
  );
  const [streamKey, setStreamKey] = useState(existing?.streamKey ?? "");
  const [saving, setSaving] = useState(false);

  const handlePlatformChange = (p: Platform) => {
    setPlatform(p);
    if (!existing) {
      setRtmpUrl(PLATFORM_CONFIG[p].defaultRtmp);
      if (!name) setName(PLATFORM_CONFIG[p].label);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);

    if (existing) {
      await updateStreamDestination({
        data: {
          id: existing.id,
          updates: {
            name: name.trim(),
            platform,
            rtmpUrl: rtmpUrl.trim(),
            streamKey: streamKey.trim(),
          },
        },
      });
    } else {
      await addStreamDestination({
        data: {
          orgId,
          name: name.trim(),
          platform,
          rtmpUrl: rtmpUrl.trim(),
          streamKey: streamKey.trim(),
        },
      });
    }

    setSaving(false);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-board-text">
            {existing ? "Edit Destination" : "Add Destination"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Platform selector */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Platform
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PLATFORM_CONFIG) as Platform[]).map((p) => {
                const config = PLATFORM_CONFIG[p];
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePlatformChange(p)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      platform === p
                        ? "bg-fire-500/15 text-fire-500 border-fire-500/25"
                        : "text-board-muted border-board-border hover:border-board-muted/50"
                    }`}
                  >
                    {config.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Church YouTube"
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
            />
          </div>

          {/* RTMP URL */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              RTMP URL
            </label>
            <input
              type="text"
              value={rtmpUrl}
              onChange={(e) => setRtmpUrl(e.target.value)}
              placeholder="rtmp://..."
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono"
            />
          </div>

          {/* Stream Key */}
          <div>
            <label className="block text-sm text-board-muted mb-1.5">
              Stream Key
            </label>
            <input
              type="password"
              value={streamKey}
              onChange={(e) => setStreamKey(e.target.value)}
              placeholder="Your stream key"
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono"
            />
          </div>

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
              disabled={saving || !name.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : existing ? "Update" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
