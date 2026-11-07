import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, useRouter, useBlocker } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useCallback, useEffect } from "react";
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
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { createBrowserId } from "@/lib/browser-id";

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

type Destination = Awaited<ReturnType<typeof getStreamDestinations>>[number];
type PlatformInitial = { destinations: Destination[]; inputs: Awaited<ReturnType<typeof getLiveInputs>>; orgId: string };
type DestinationDraft = { name: string; platform: Platform; rtmpUrl: string; streamKey: string };
const controlClass = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";
function platformName(value: string): Platform {
  return value === "youtube" || value === "facebook" || value === "twitch" ? value : "custom";
}

function PlatformsPage() {
  const initial = Route.useLoaderData();
  return <PlatformsWorkspace key={initial.orgId} initial={initial} />;
}
export function PlatformsWorkspace({ initial }: { initial: PlatformInitial }) {
  const { orgId } = initial;
  const router = useRouter();
  const readConfiguration = useCallback(async (signal: AbortSignal) => {
    const [destinations, inputs] = await Promise.all([
      getStreamDestinations({ data: { orgId }, signal }), getLiveInputs({ data: { orgId }, signal }),
    ]);
    return { destinations, inputs };
  }, [orgId]);
  const read = useOperatorRead({
    key: JSON.stringify([orgId, initial.destinations, initial.inputs]),
    initialValue: { destinations: initial.destinations, inputs: initial.inputs }, read: readConfiguration,
    errorMessage: "Destinations could not be refreshed. Previously confirmed values are shown. Retry before making changes.",
  });
  const { destinations, inputs } = read.value;
  const writes = useConfirmedWrite(orgId);
  const locked = writes.state.status !== "idle", busy = writes.state.status === "saving";
  const controlsDisabled = locked || read.refreshing || !!read.error;
  const [editor, setEditor] = useState<{ key: string; existing: Destination | null; open: boolean } | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const dirty = locked || formDirty;
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  useEffect(() => { if (!dirty && blocker.status === "blocked") blocker.proceed(); }, [dirty, blocker]);
  const openEditor = (existing: Destination | null) => {
    if (controlsDisabled) return;
    setFormDirty(false); setEditor({ key: createBrowserId(), existing, open: true });
  };
  const closeEditor = async () => {
    if (busy) return;
    if (locked) { setEditor(current => current ? { ...current, open: false } : null); return; }
    if (formDirty && !await confirm({ title: "Discard destination draft?", description: "Your unsaved destination fields will be discarded.", confirmLabel: "Discard draft" })) return;
    setEditor(null); setFormDirty(false);
  };
  const saveDraft = (draft: DestinationDraft) => {
    if (!editor || controlsDisabled) return;
    const existing = editor.existing;
    void writes.start({
      label: existing ? "Update destination" : "Add destination",
      write: (requestId, signal) => existing
        ? updateStreamDestination({ data: { orgId, id: existing.id, requestId, updates: draft }, signal })
        : addStreamDestination({ data: { orgId, requestId, ...draft }, signal }),
      apply: () => read.invalidate(),
      finish: async (_result, signal) => {
        const confirmed = await read.refresh(); signal.throwIfAborted();
        if (!confirmed) throw new Error("The destination was saved, but the list could not be refreshed. Retry refresh without repeating the save.");
        setEditor(null); setFormDirty(false);
      },
    });
  };
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (!await confirm({ title: "Review stored destinations?", description: "The previous save may already have completed. Check the refreshed list before submitting another destination. Your draft will be kept.", confirmLabel: "Review destinations", variant: "warning" })) return;
    setReviewing(true);
    if (await read.refresh()) writes.discard();
    setReviewing(false);
  };
  const notice = <><ConfirmedWriteNotice collectionLabel="destinations" state={writes.state} retry={() => void writes.retry()} review={() => void reviewStored()} reviewing={reviewing} />{editor?.open && read.error && <p role="alert" className="text-sm text-amber-200">{read.error.message}</p>}</>;
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
    <div className="h-full min-w-0 overflow-auto">
      {ConfirmDialogEl}
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
                  disabled={stopping || controlsDisabled}
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
                  disabled={controlsDisabled || goingLive || !hasInputs || activeCount === 0}
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
                onClick={() => openEditor(null)} disabled={controlsDisabled}
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
        <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry destinations" />
        {!editor?.open && notice}
        {editor && !editor.open && <button className={controlClass} onClick={() => setEditor({ ...editor, open: true })}>Review destination draft</button>}
        {read.refreshing && <p role="status" className="text-xs text-board-muted">Refreshing destinations… Previously confirmed values are shown.</p>}
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
                onClick={() => openEditor(null)} disabled={controlsDisabled}
              >
                Add Destination
              </EmptyStateButton>
            }
          />
        ) : (
          <div className="space-y-3">
            {destinations.map((dest) => {
              const platformCfg =
                PLATFORM_CONFIG[platformName(dest.platform)] ?? PLATFORM_CONFIG.custom;
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
                      <button disabled={controlsDisabled} onClick={() => handleToggle(dest.id, dest.enabled)} className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted outline-none hover:bg-board-border/50 focus-visible:ring-2 focus-visible:ring-fire-500" aria-label={`${dest.enabled ? "Disable" : "Enable"} ${dest.name}`}>
                        {dest.enabled ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                      </button>
                      <button type="button" disabled={controlsDisabled} onClick={() => openEditor(dest)} aria-label={`Edit ${dest.name}`} className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted outline-none hover:bg-board-border/50 focus-visible:ring-2 focus-visible:ring-fire-500"><Pencil className="h-4 w-4" /></button>
                      <button type="button" disabled={controlsDisabled} onClick={() => handleDelete(dest.id)} aria-label={`Delete ${dest.name}`} className="min-h-11 min-w-11 rounded-lg p-2 text-red-400 outline-none hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-fire-500"><Trash2 className="h-4 w-4" /></button>
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

        {editor && <DestinationFormModal key={editor.key} existing={editor.existing} open={editor.open} locked={locked} busy={busy} controlsDisabled={controlsDisabled} onClose={() => void closeEditor()} onSave={saveDraft} onDirty={setFormDirty} notice={notice} />}
        <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open && blocker.status === "blocked") blocker.reset(); }}>
          <DialogContent aria-modal="true" showCloseButton={false} className="border-board-border bg-board-card text-board-text"><DialogTitle>Leave Multi-Platform?</DialogTitle><DialogDescription>Unsaved drafts and retry controls will be discarded. An unconfirmed save may still complete. Review stored destinations when you return.</DialogDescription><div className="flex flex-wrap gap-2"><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.reset()}>Stay</button><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.proceed()}>Leave Multi-Platform</button></div></DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function DestinationFormModal({ existing, open, locked, busy, controlsDisabled, onClose, onSave, onDirty, notice }: {
  existing: Destination | null; open: boolean; locked: boolean; busy: boolean; controlsDisabled: boolean;
  onClose: () => void; onSave: (draft: DestinationDraft) => void; onDirty: (dirty: boolean) => void; notice: React.ReactNode;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const [name, setName] = useState(existing?.name ?? "");
  const [platform, setPlatform] = useState<Platform>(existing ? platformName(existing.platform) : "youtube");
  const [rtmpUrl, setRtmpUrl] = useState(existing?.rtmpUrl ?? PLATFORM_CONFIG.youtube.defaultRtmp);
  const [streamKey, setStreamKey] = useState("");
  const dirty = name !== (existing?.name ?? "") || platform !== (existing ? platformName(existing.platform) : "youtube") || rtmpUrl !== (existing?.rtmpUrl ?? PLATFORM_CONFIG.youtube.defaultRtmp) || !!streamKey;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const fieldClass = "min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text outline-none focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-50";
  const changePlatform = (next: Platform) => {
    setPlatform(next);
    if (!existing) { setRtmpUrl(PLATFORM_CONFIG[next].defaultRtmp); if (!name) setName(PLATFORM_CONFIG[next].label); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent aria-modal="true" showCloseButton={false} className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-board-border p-4">
        <div className="space-y-2"><DialogTitle>{existing ? "Edit Destination" : "Add Destination"}</DialogTitle><DialogDescription>Save the destination credentials. Enable it and use Go Live separately to start forwarding.</DialogDescription></div>
        <button type="button" disabled={busy} onClick={onClose} aria-label="Close destination editor" className={`${controlClass} min-w-11`}><X className="size-4" /></button>
      </div>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); if (!controlsDisabled) onSave({ name: name.trim(), platform, rtmpUrl: rtmpUrl.trim(), streamKey: streamKey.trim() }); }}>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4">
          {notice}
          <fieldset disabled={locked} className="space-y-4">
            <fieldset><legend className="mb-2 text-sm text-board-muted">Platform</legend><div className="grid grid-cols-2 gap-2">{(["youtube", "facebook", "twitch", "custom"] satisfies Platform[]).map(value => <button type="button" key={value} aria-pressed={platform === value} onClick={() => changePlatform(value)} className={`${controlClass} ${platform === value ? "border-fire-500 bg-fire-500/10 text-fire-500" : ""}`}>{PLATFORM_CONFIG[value].label}</button>)}</div></fieldset>
            <div className="space-y-2"><label htmlFor="destination-name" className="text-sm text-board-muted">Display Name</label><input id="destination-name" required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder={workspaceCopy("e.g. Church YouTube", workspaceTerms)} className={fieldClass} /></div>
            <div className="space-y-2"><label htmlFor="destination-url" className="text-sm text-board-muted">RTMP URL</label><input id="destination-url" required maxLength={500} pattern="[rR][tT][mM][pP][sS]?://.*" value={rtmpUrl} onChange={event => setRtmpUrl(event.target.value)} placeholder="rtmps://…" className={`${fieldClass} font-mono`} /></div>
            <div className="space-y-2"><label htmlFor="destination-key" className="text-sm text-board-muted">{existing ? "New stream key" : "Stream key"}</label><input id="destination-key" type="password" autoComplete="new-password" required={!existing} maxLength={500} value={streamKey} onChange={event => setStreamKey(event.target.value)} aria-describedby="destination-key-help" className={`${fieldClass} font-mono`} /><p id="destination-key-help" className="text-xs text-board-muted">{existing ? "Leave blank to keep the stored key. Disable a connected destination before replacing its credentials." : "Enter the stream key from your destination platform."}</p></div>
          </fieldset>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-board-border p-4"><button type="button" disabled={busy} onClick={onClose} className={controlClass}>{locked ? "Close editor" : "Cancel"}</button><button type="submit" disabled={controlsDisabled || !name.trim() || !rtmpUrl.trim() || (!existing && !streamKey.trim())} className={`${controlClass} bg-fire-500 text-black`}>{busy ? "Saving…" : existing ? "Update destination" : "Add destination"}</button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
