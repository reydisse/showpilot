import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useCallback } from "react";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { RouteError } from "@/components/ui/RouteRecovery";
import {
  Radio,
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Zap,
  ZapOff,
  Loader2,
  XCircle,
  X,
  Link,
} from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import {
  getStreamDestinations,
  addStreamDestination,
  updateStreamDestination,
  deleteStreamDestination,
  toggleStreamDestination,
  connectDestinationsToInput,
  disconnectAllDestinations,
  getOutputStatuses,
  type StreamOutputStatus,
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
  errorComponent: RouteError,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "streaming_suite:access", context.slug, context.orgId);
    const [destinations, inputs] = await Promise.all([
      getStreamDestinations({ data: { orgId: context.orgId }, signal: abortController.signal }),
      getLiveInputs({ data: { orgId: context.orgId }, signal: abortController.signal }),
    ]);
    return { destinations, inputs, orgId: context.orgId };
  },
  component: PlatformsPage,
});

function PlatformsPage() {
  const { destinations, inputs, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editDest, setEditDest] = useState<(typeof destinations)[0] | null>(
    null,
  );
  const [goingLive, setGoingLive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const activeCount = destinations.filter((d) => d.enabled).length;
  const connectedCount = destinations.filter((d) => d.cfOutputId).length;
  const hasInputs = inputs.length > 0;
  const outputKey = JSON.stringify([orgId, destinations.map(destination => [destination.id, destination.cfOutputId, destination.liveInputId])]);
  const readOutputs = useCallback((signal: AbortSignal) => getOutputStatuses({ data: { orgId }, signal }), [orgId]);
  const outputRead = useOperatorRead<Record<string, StreamOutputStatus>>({
    key: outputKey,
    initialValue: {},
    read: readOutputs,
    enabled: connectedCount > 0,
    intervalMs: 5_000,
    errorMessage: "Output status could not be refreshed. Last confirmed values are kept; verify the broadcast on each destination platform.",
  });
  const outputStatuses = outputRead.value;
  const unknownCount = Object.values(outputStatuses).filter(state => state.status === "unknown").length;
  const outputFailure = outputRead.error ?? (unknownCount && outputRead.confirmedAt !== null ? {
    message: `Could not confirm ${unknownCount} output${unknownCount === 1 ? "" : "s"}. Retry output status or check the destination platform.`,
    occurredAt: outputRead.confirmedAt,
  } : null);

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setActionError(null);
    try {
      await toggleStreamDestination({ data: { id, enabled: !currentEnabled } });
      router.invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to toggle destination");
    }
  };

  const handleDelete = async (id: string) => {
    setActionError(null);
    try {
      await deleteStreamDestination({ data: { id } });
      router.invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete destination");
    }
  };

  const handleGoLive = async () => {
    if (!hasInputs) return;
    setGoingLive(true);
    setActionError(null);
    try {
      const results = await connectDestinationsToInput({
        data: { orgId, liveInputId: inputs[0].id },
      });
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        setActionError(`${failed.length} destination(s) failed to connect: ${failed.map((f) => f.error).join("; ")}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to go live");
    }
    setGoingLive(false);
    router.invalidate();
  };

  const handleStopAll = async () => {
    setStopping(true);
    setActionError(null);
    try {
      const results = await disconnectAllDestinations({ data: { orgId } });
      const failed = results.filter((result) => !result.success);
      if (failed.length > 0) {
        setActionError(`${failed.length} destination(s) could not be stopped: ${failed.map((result) => result.error).join("; ")}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to stop streams");
    }
    setStopping(false);
    router.invalidate();
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 md:px-6 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Multi-Platform
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Simulcast to multiple streaming platforms
            </p>
          </div>
          {destinations.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {connectedCount > 0 ? (
                <button
                  onClick={handleStopAll}
                  disabled={stopping}
                  className="flex min-h-[44px] items-center gap-1.5 px-4 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 disabled:opacity-50 transition-colors"
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
                  className="flex min-h-[44px] items-center gap-1.5 px-4 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50 transition-colors"
                  title={!hasInputs ? "Create a live input on Stream first" : activeCount === 0 ? "Enable at least one destination" : ""}
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
                className="flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 rounded-lg border border-board-border text-board-muted text-xs font-medium hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add Destination
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
        <ReadFailureNotice error={outputFailure} refreshing={outputRead.refreshing} retry={outputRead.retry} label="Retry output status" />
        {connectedCount > 0 && (() => {
          const enabled = Object.values(outputStatuses).filter(state => state.status === "enabled").length;
          const checked = Object.keys(outputStatuses).length > 0;
          return <section aria-label="Output status" className="space-y-2 rounded-xl border border-board-border bg-board-card px-4 py-3 text-sm text-board-text">
            <p>{outputRead.error ? "Last confirmed: " : ""}{checked ? `${enabled} output${enabled === 1 ? "" : "s"} enabled${unknownCount ? ` · ${unknownCount} status${unknownCount === 1 ? "" : "es"} unavailable` : ""}` : outputRead.refreshing ? "Checking output status…" : "Output status unavailable"}</p>
            <p className="text-xs text-board-muted">Enabled means forwarding is configured. Verify the broadcast on each destination platform.</p>
            {outputRead.confirmedAt !== null && <p className="text-xs text-board-muted">Checked <time dateTime={new Date(outputRead.confirmedAt).toISOString()}>{new Date(outputRead.confirmedAt).toLocaleTimeString()}</time>{outputRead.refreshing ? " · Refreshing…" : ""}</p>}
          </section>;
        })()}

        {/* No input warning */}
        {!hasInputs && destinations.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
            <Link className="w-4 h-4 text-yellow-400 shrink-0" />
            <p className="text-xs text-yellow-400">
              No live input configured. Create one on the Stream page to enable simulcasting.
            </p>
          </div>
        )}

        {/* Action error banner */}
        {actionError && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-xs text-red-400 flex-1">{actionError}</p>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              className="text-red-400/60 hover:text-red-400 transition-colors text-sm leading-none"
            >
              <X className="size-3.5" />
            </button>
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
              {connectedCount} configured output{connectedCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Destinations list */}
        {destinations.length === 0 ? (
          <EmptyState
            icon={Radio}
            title="No streaming destinations"
            description="Add YouTube, Facebook, Twitch, or custom RTMP destinations to simulcast your live input."
            action={
              <EmptyStateButton
                onClick={() => {
                  setEditDest(null);
                  setShowForm(true);
                }}
              >
                Add Destination
              </EmptyStateButton>
            }
          />
        ) : (
          <div className="space-y-3">
            {destinations.map((dest) => {
              const platformCfg =
                PLATFORM_CONFIG[dest.platform as Platform] ?? PLATFORM_CONFIG.custom;
              const isConnected = !!dest.cfOutputId;
              const outputStatus = outputStatuses[dest.id];
              const outputLabel = outputStatus?.status === "enabled" ? "Output enabled"
                : outputStatus?.status === "disabled" ? "Output disabled"
                : outputStatus?.status === "missing" ? "Output missing at provider"
                : outputStatus?.status === "unconfirmed" ? "Connection unconfirmed"
                : outputStatus?.status === "unknown" || outputRead.error ? "Output status unavailable"
                : outputRead.confirmedAt !== null || !outputRead.refreshing ? "Output status unavailable" : "Checking output status…";
              const outputError = outputStatus?.status === "unknown" ? outputStatus.error : null;

              return (
                <div key={dest.id} className={`rounded-xl border p-5 ${dest.enabled ? "bg-board-card border-board-border" : "bg-board-card/50 border-board-border/50"}`}>
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <span className={`inline-block rounded border px-2 py-1 text-xs font-medium ${platformCfg.color}`}>{platformCfg.label}</span>
                      <p className="break-words text-sm font-semibold text-board-text">{dest.name}</p>
                      {isConnected && <p className="text-xs text-board-muted">{outputRead.error && outputStatus ? "Last confirmed: " : ""}{outputLabel}</p>}
                      {outputError && <p className="text-xs text-amber-200">{outputError}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => handleToggle(dest.id, dest.enabled)} className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted outline-none hover:bg-board-border/50 focus-visible:ring-2 focus-visible:ring-fire-500" aria-label={`${dest.enabled ? "Disable" : "Enable"} ${dest.name}`}>
                        {dest.enabled ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                      </button>
                      <button type="button" onClick={() => { setEditDest(dest); setShowForm(true); }} aria-label={`Edit ${dest.name}`} className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted outline-none hover:bg-board-border/50 focus-visible:ring-2 focus-visible:ring-fire-500"><Pencil className="h-4 w-4" /></button>
                      <button type="button" onClick={() => handleDelete(dest.id)} aria-label={`Delete ${dest.name}`} className="min-h-11 min-w-11 rounded-lg p-2 text-red-400 outline-none hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-fire-500"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>

                  {dest.rtmpUrl && (
                    <p className="text-[11px] text-board-muted font-mono truncate mb-1">
                      {dest.rtmpUrl}
                    </p>
                  )}

                  {dest.hasStreamKey && (
                    <p className="text-[11px] text-board-muted/60">
                      Stream key saved · enter a new key to replace it
                    </p>
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
              An enabled output confirms the forwarding configuration. Check the incoming video and broadcast state in YouTube Studio before telling viewers the stream is live.
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
              Make sure you have a live input configured on the Stream page and your encoder is sending to it.
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
  const workspaceTerms = useWorkspaceTerms();
  const [name, setName] = useState(existing?.name ?? "");
  const [platform, setPlatform] = useState<Platform>(
    (existing?.platform as Platform) ?? "youtube"
  );
  const [rtmpUrl, setRtmpUrl] = useState(
    existing?.rtmpUrl ?? PLATFORM_CONFIG.youtube.defaultRtmp
  );
  const [streamKey, setStreamKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
    setError("");
    try {
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
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Destination update failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-board-text">
            {existing ? "Edit Destination" : "Add Destination"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close destination editor"
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Status banner */}
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
              placeholder={workspaceCopy("e.g. Church YouTube", workspaceTerms)}
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
              {existing ? "New stream key" : "Stream key"}
            </label>
            <input
              type="password"
              value={streamKey}
              onChange={(e) => setStreamKey(e.target.value)}
              placeholder={existing ? "Leave blank to keep the stored key" : "Your stream key"}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm font-mono"
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
          ) : null}

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
              disabled={saving || !name.trim() || !rtmpUrl.trim() || (!existing && !streamKey.trim())}
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
