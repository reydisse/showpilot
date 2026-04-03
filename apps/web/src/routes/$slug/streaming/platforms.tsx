import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect, useRef } from "react";
import {
  Radio,
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
  Zap,
  ZapOff,
  Loader2,
  CheckCircle2,
  XCircle,
  Link,
} from "lucide-react";
import {
  getStreamDestinations,
  addStreamDestination,
  updateStreamDestination,
  deleteStreamDestination,
  toggleStreamDestination,
  connectDestinationsToInput,
  disconnectAllDestinations,
  getOutputStatuses,
} from "@/lib/stream-destinations";
import { getLiveInputs } from "@/lib/stream";

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
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const [destinations, inputs] = await Promise.all([
      getStreamDestinations({ data: { orgId: context.orgId } }),
      getLiveInputs({ data: { orgId: context.orgId } }),
    ]);
    return { destinations, inputs, orgId: context.orgId };
  },
  component: PlatformsPage,
});

function PlatformsPage() {
  const { destinations, inputs, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editDest, setEditDest] = useState<typeof destinations[0] | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [goingLive, setGoingLive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [outputStatuses, setOutputStatuses] = useState<Record<string, { status: string; error?: string }>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeCount = destinations.filter((d) => d.enabled).length;
  const connectedCount = destinations.filter((d) => d.cfOutputId).length;
  const hasInputs = inputs.length > 0;

  // Poll output statuses when there are connected destinations
  useEffect(() => {
    if (connectedCount === 0) {
      setOutputStatuses({});
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const statuses = await getOutputStatuses({ data: { orgId } });
        setOutputStatuses(statuses);
      } catch {
        // Silently continue
      }
    };

    poll(); // Immediate first poll
    pollRef.current = setInterval(poll, 5000); // Then every 5s

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [connectedCount, orgId]);

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

  const handleGoLive = async () => {
    if (!hasInputs) return;
    setGoingLive(true);
    try {
      await connectDestinationsToInput({
        data: { orgId, liveInputId: inputs[0].id },
      });
    } catch (err) {
      console.error("Failed to go live:", err);
    }
    setGoingLive(false);
    router.invalidate();
  };

  const handleStopAll = async () => {
    setStopping(true);
    try {
      await disconnectAllDestinations({ data: { orgId } });
    } catch (err) {
      console.error("Failed to stop:", err);
    }
    setStopping(false);
    router.invalidate();
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
              Simulcast to multiple streaming platforms
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connectedCount > 0 ? (
              <button
                onClick={handleStopAll}
                disabled={stopping}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 disabled:opacity-50 transition-colors"
              >
                {stopping ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ZapOff className="w-3.5 h-3.5" />
                )}
                Stop All
              </button>
            ) : (
              <button
                onClick={handleGoLive}
                disabled={goingLive || !hasInputs || activeCount === 0}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50 transition-colors"
                title={!hasInputs ? "Create a live input on Stream Health first" : activeCount === 0 ? "Enable at least one destination" : ""}
              >
                {goingLive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                Go Live
              </button>
            )}
            <button
              onClick={() => {
                setEditDest(null);
                setShowForm(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Destination
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto space-y-5">
        {/* Status banner */}
        {connectedCount > 0 && (() => {
          const liveOutputs = Object.values(outputStatuses).filter((s) => s.status === "connected").length;
          const connectingOutputs = connectedCount - liveOutputs;
          return (
            <div className={`flex items-center justify-between px-4 py-3 rounded-xl ${
              liveOutputs > 0 ? "bg-green-500/10 border border-green-500/20" : "bg-amber-500/10 border border-amber-500/20"
            }`}>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full animate-pulse ${liveOutputs > 0 ? "bg-green-500" : "bg-amber-500"}`} />
                <span className={`text-sm font-medium ${liveOutputs > 0 ? "text-green-400" : "text-amber-400"}`}>
                  {liveOutputs > 0
                    ? `Live on ${liveOutputs} platform${liveOutputs !== 1 ? "s" : ""}${connectingOutputs > 0 ? ` (${connectingOutputs} connecting...)` : ""}`
                    : `Connecting to ${connectingOutputs} platform${connectingOutputs !== 1 ? "s" : ""}...`}
                </span>
              </div>
              <button
                onClick={handleStopAll}
                disabled={stopping}
                className="text-xs text-red-400 hover:text-red-300 font-medium transition-colors"
              >
                Stop All
              </button>
            </div>
          );
        })()}

        {/* No input warning */}
        {!hasInputs && destinations.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
            <Link className="w-4 h-4 text-yellow-400 shrink-0" />
            <p className="text-xs text-yellow-400">
              No live input configured. Create one on the Stream Health page to enable simulcasting.
            </p>
          </div>
        )}

        {/* Summary */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-fire-500" />
            <span className="text-sm font-medium text-board-text">
              {destinations.length} destination{destinations.length !== 1 ? "s" : ""}
            </span>
          </div>
          <span className="text-xs text-board-muted">
            {activeCount} enabled
          </span>
          {connectedCount > 0 && (
            <span className="text-xs text-fire-500 font-medium">
              {connectedCount} connected
            </span>
          )}
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
              const isConnected = !!dest.cfOutputId;
              const outputStatus = outputStatuses[dest.id];
              const isLive = outputStatus?.status === "connected";
              const isConnecting = isConnected && !isLive && !outputStatus?.error;

              return (
                <div
                  key={dest.id}
                  className={`rounded-xl border p-5 transition-all ${
                    isLive
                      ? "bg-green-500/5 border-green-500/20"
                      : isConnecting
                        ? "bg-amber-500/5 border-amber-500/20"
                        : isConnected
                          ? "bg-fire-500/5 border-fire-500/20"
                          : dest.enabled
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
                      {isConnected && (
                        <span className={`flex items-center gap-1 text-[10px] font-medium ${
                          isLive ? "text-green-400" : isConnecting ? "text-amber-400" : outputStatus?.error ? "text-red-400" : "text-fire-500"
                        }`}>
                          {isLive ? (
                            <>
                              <CheckCircle2 className="w-3 h-3" />
                              Live
                            </>
                          ) : isConnecting ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Connecting to {platformCfg.label}...
                            </>
                          ) : outputStatus?.error ? (
                            <>
                              <XCircle className="w-3 h-3" />
                              {outputStatus.error}
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3 h-3" />
                              Relay created
                            </>
                          )}
                        </span>
                      )}
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

        {/* YouTube timing note — show when YouTube destination exists */}
        {connectedCount > 0 && destinations.some((d) => d.platform === "youtube") && (
          <div className="px-4 py-3 rounded-xl bg-blue-500/5 border border-blue-500/15">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400 mb-1">YouTube Timing</p>
            <p className="text-xs text-board-muted">
              After ShowPilot shows "Live", YouTube still needs 1-3 minutes to process the incoming stream before viewers see it.
              Make sure your YouTube stream is set to "Go Live" in YouTube Studio <strong className="text-board-text">before</strong> you
              click Go Live here — otherwise YouTube may reject the incoming stream until you start the broadcast on their end.
            </p>
          </div>
        )}

        {/* Info */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-2">
            How It Works
          </p>
          <div className="space-y-1.5 text-xs text-board-muted">
            <p>
              <strong className="text-board-text">1.</strong> Add your streaming platform credentials (RTMP URL + stream key).
            </p>
            <p>
              <strong className="text-board-text">2.</strong> Enable the destinations you want to stream to.
            </p>
            <p>
              <strong className="text-board-text">3.</strong> Hit <strong className="text-fire-500">Go Live</strong> to start simulcasting via Cloudflare Stream Connect.
            </p>
            <p className="text-board-muted/50 mt-2">
              Make sure you have a live input configured on the Stream Health page and your encoder is sending to it.
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
