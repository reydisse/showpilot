import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect, useCallback, useRef } from "react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import {
  Activity,
  Wifi,
  Plus,
  Trash2,
  Copy,
  Check,
  Radio,
  ChevronDown,
  ChevronRight,
  Monitor,
  Tv,
  Cable,
  Eye,
  EyeOff,
  RefreshCw,
  X,
} from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  getLiveInputs,
  createLiveInput,
  deleteLiveInput,
  resumeLiveInput,
} from "@/lib/stream";

import { RouteError } from "@/components/ui/RouteRecovery";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { useLiveInputHealth } from "@/hooks/useLiveInputHealth";
import { ConfirmedWriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const controlClass = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";
export const Route = createFileRoute("/$slug/streaming/health")({
  pendingComponent: () => <PageSkeleton />,
  errorComponent: RouteError,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "stream_health:view", context.slug, context.orgId);
    const canManageStreamHealth = hasEffectivePermission(
      context.role,
      context.grantedPermissions,
      "stream_health:manage",
    );
    const inputs = await getLiveInputs({ data: { orgId: context.orgId, includeCredentials: canManageStreamHealth }, signal: abortController.signal });
    return {
      inputs,
      orgId: context.orgId,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
    };
  },
  component: StreamHealthPage,
});

type Initial = Awaited<ReturnType<typeof getLiveInputs>>;
function StreamHealthPage() {
  const initial = Route.useLoaderData();
  const canManage = hasEffectivePermission(initial.role, initial.grantedPermissions, "stream_health:manage");
  return <StreamHealthWorkspace key={initial.orgId} orgId={initial.orgId} initialInputs={initial.inputs} canManageStreamHealth={canManage} />;
}

export function StreamHealthWorkspace({ orgId, initialInputs, canManageStreamHealth }: { orgId: string; initialInputs: Initial; canManageStreamHealth: boolean }) {
  const workspaceTerms = useWorkspaceTerms();
  const readInputs = useCallback((signal: AbortSignal) => getLiveInputs({ data: { orgId, includeCredentials: canManageStreamHealth }, signal }), [orgId, canManageStreamHealth]);
  const read = useOperatorRead({ key: JSON.stringify([orgId, initialInputs, canManageStreamHealth]), initialValue: initialInputs, read: readInputs, errorMessage: "Inputs could not be refreshed. Previously confirmed configuration is shown. Retry before making changes." });
  const inputs = read.value;
  const healthRead = useLiveInputHealth(orgId, inputs);
  const statuses = healthRead.value;
  const polling = healthRead.refreshing;
  const lastCheckedAt = healthRead.confirmedAt;
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const writes = useConfirmedWrite(orgId);
  const busy = writes.state.status === "saving", locked = writes.state.status !== "idle";
  const controlsDisabled = locked || read.refreshing || !!read.error;
  const dirty = locked || newName.length > 0;
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  useEffect(() => { if (!dirty && blocker.status === "blocked") blocker.proceed(); }, [dirty, blocker]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const finish = async (_result: unknown, signal: AbortSignal) => {
    const refreshed = await read.refresh(); signal.throwIfAborted();
    if (!refreshed) throw new Error("The input change completed, but the list could not be refreshed. Retry refresh without repeating the change.");
  };
  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || controlsDisabled) return;
    const name = newName.trim();
    void writes.start({ label: "Create live input", write: (requestId, signal) => createLiveInput({ data: { orgId, name, requestId }, signal }),
      apply: () => read.invalidate(), finish: async (result, signal) => { await finish(result, signal); setNewName(""); setShowAddForm(false); },
    });
  };
  const handleDelete = async (input: Initial[number]) => {
    if (controlsDisabled || !await confirm({ title: `Delete ${input.name}?`, description: "This removes the ingest point and its stream key. Encoders using it will stop connecting. Stop every destination output first.", confirmLabel: "Delete input", variant: "danger" })) return;
    void writes.start({ label: `Delete ${input.name}`, write: (requestId, signal) => deleteLiveInput({ data: { orgId, inputId: input.id, requestId }, signal }), apply: () => read.invalidate(), finish });
  };
  const handleResume = (input: Initial[number]) => {
    if (controlsDisabled) return;
    void writes.start({ label: `Resume ${input.name}`, write: (_requestId, signal) => resumeLiveInput({ data: { orgId, inputId: input.id }, signal }), apply: () => read.invalidate(), finish });
  };
  const closeEditor = async () => {
    if (busy) return;
    if (locked) { setShowAddForm(false); return; }
    if (newName && !await confirm({ title: "Discard input draft?", description: "The unsaved input name will be discarded.", confirmLabel: "Discard draft" })) return;
    setNewName(""); setShowAddForm(false);
  };
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (!await confirm({ title: "Review stored inputs?", description: "The previous request may still complete. Resume any pending input instead of creating another. Your draft will be kept; submitting it again starts a new creation.", confirmLabel: "Review inputs", variant: "warning" })) return;
    setReviewing(true); if (await read.refresh()) writes.discard(); setReviewing(false);
  };
  const notice = <ConfirmedWriteNotice collectionLabel="inputs" state={writes.state} retry={() => void writes.retry()} review={() => void reviewStored()} reviewing={reviewing} />;
  const liveCount = healthRead.error ? 0 : inputs.filter(i => statuses[i.id]?.status === "streaming").length;
  const connectedCount = healthRead.error ? 0 : inputs.filter(i => ["streaming", "connecting"].includes(statuses[i.id]?.status)).length;
  const unknownCount = healthRead.unknownCount;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 md:px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Stream
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Live inputs, encoder setup, and health monitoring
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            {polling && (
              <RefreshCw className="w-3.5 h-3.5 text-board-muted animate-spin" />
            )}
            {canManageStreamHealth && inputs.length > 0 && (
              <button
                onClick={() => setShowAddForm(true)}
                disabled={controlsDisabled}
                className="flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
              >
                <Plus className="w-3 h-3" />
                Add Input
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-board-card border border-board-border">
            <div className="flex items-center gap-2 mb-2">
              <Radio className={`w-4 h-4 ${liveCount > 0 ? "text-green-400" : "text-board-muted"}`} />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Status
              </span>
            </div>
            <p className={`text-lg font-semibold ${liveCount > 0 ? "text-green-400" : "text-board-muted"}`}>
              {liveCount > 0 ? "Live" : unknownCount > 0 ? "Unknown" : "Offline"}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-board-card border border-board-border">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-board-muted" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Inputs
              </span>
            </div>
            <p className="text-lg font-semibold text-board-text tabular-nums">
              {inputs.length}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-board-card border border-board-border">
            <div className="flex items-center gap-2 mb-2">
              <Wifi className="w-4 h-4 text-board-muted" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Connected
              </span>
            </div>
            <p className="text-lg font-semibold text-board-text tabular-nums">
              {connectedCount}<span className="ml-1 text-xs font-normal text-board-muted">/ {inputs.length}</span>
            </p>
            {lastCheckedAt && (
              <p className="mt-1 text-[9px] text-board-muted">Checked {new Date(lastCheckedAt).toLocaleTimeString()}</p>
            )}
          </div>
        </div>

        <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry inputs" />
        <ReadFailureNotice error={healthRead.failure} refreshing={polling} retry={healthRead.retry} label="Retry input health" />
        {!showAddForm && notice}
        {!showAddForm && newName && <button className={controlClass} onClick={() => setShowAddForm(true)}>Review input draft</button>}
        {/* Stats row */}
        {inputs.length === 0 && (read.refreshing || read.error) ? <p role="status" className="text-sm text-board-muted">{read.refreshing ? "Loading inputs…" : "Input list unavailable. Retry above."}</p> : inputs.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No live inputs configured"
            description="Create a live input to start receiving video from your encoder, then monitor its health here."
            action={
              canManageStreamHealth ? (
                <EmptyStateButton onClick={() => setShowAddForm(true)}>
                  Create Live Input
                </EmptyStateButton>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {inputs.map((input) => {
              const health = statuses[input.id];
              const status = healthRead.error ? "unknown" : health?.status ?? "unknown";
              const isLive = status === "streaming";
              const isConnected = status === "connecting";

              return (
                <div
                  key={input.id}
                  className={`rounded-xl border p-5 ${
                    isLive
                      ? "bg-green-500/5 border-green-500/20"
                      : isConnected
                        ? "bg-blue-500/5 border-blue-500/20"
                        : "bg-board-card border-board-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div
                        className={`w-3 h-3 rounded-full ${
                          isLive
                            ? "bg-green-500 animate-pulse"
                            : isConnected
                              ? "bg-blue-500"
                              : "bg-board-muted"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-board-text">
                          {input.name}
                        </p>
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider ${
                            isLive
                              ? "text-green-400"
                              : isConnected
                                ? "text-blue-400"
                                : "text-board-muted"
                          }`}
                        >
                          {isLive ? "Streaming" : isConnected ? "Reconnecting" : status === "error" ? "Fault" : status === "unknown" ? "Unknown" : status === "disabled" ? "Disabled" : "Idle"}
                        </span>
                        {health && (
                          <p className="mt-1 text-[9px] text-board-muted">{healthRead.error ? "Last confirmed" : "Provider"}: {health.providerStatus.replaceAll("_", " ")} · {new Date(health.checkedAt).toLocaleTimeString()}</p>
                        )}
                        {health?.error && (
                          <p className="mt-1 text-[10px] text-red-400">{health.error}</p>
                        )}
                      </div>
                    </div>
                    {canManageStreamHealth && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(input)}
                        disabled={controlsDisabled}
                        aria-label={`Delete ${input.name} stream input`}
                        title={`Delete ${input.name} stream input`}
                        className="min-h-11 min-w-11 shrink-0 flex items-center justify-center rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-fire-500"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {input.setupState !== "ready" && <div className="mb-4 space-y-2 text-sm text-amber-200">
                    <p>{input.setupState === "deleting" ? "Removal is pending. Retry removal to confirm the result." : "Setup is pending. Resume to recover the same input."}</p>
                    {canManageStreamHealth && <button className={controlClass} disabled={controlsDisabled} onClick={() => input.setupState === "deleting" ? void handleDelete(input) : handleResume(input)}>{input.setupState === "deleting" ? "Retry removal" : "Resume setup"}</button>}
                  </div>}
                  <div className="space-y-2">
                    {input.rtmpUrl && (
                      <CopyField
                        label="RTMPS URL"
                        value={input.rtmpUrl}
                        fieldId={`rtmp-${input.id}`}
                      />
                    )}
                    {input.rtmpKey && (
                      <CopyField
                        label="Stream Key"
                        value={input.rtmpKey}
                        fieldId={`key-${input.id}`}
                        secret
                      />
                    )}
                    {input.srtUrl && (
                      <CopyField
                        label="SRT URL"
                        value={input.srtUrl}
                        fieldId={`srt-${input.id}`}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Stats row */}
        <div className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 px-1">
            Encoder Setup Guides
          </p>

          {/* Stats row */}
          <SetupGuide
            id="atem"
            icon={<Tv className="w-4 h-4" />}
            title="Blackmagic ATEM Mini Pro / ISO"
            subtitle="Direct RTMP streaming from the switcher — no computer needed"
            expanded={expandedGuide === "atem"}
            onToggle={() => setExpandedGuide(expandedGuide === "atem" ? null : "atem")}
          >
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">Requirements</h4>
                <ul className="text-xs text-board-muted space-y-1 list-disc list-inside">
                  <li>ATEM Mini <span className="text-amber-400">Pro</span>, <span className="text-amber-400">Pro ISO</span>, or <span className="text-amber-400">Extreme</span> (original Mini does not have streaming)</li>
                  <li>Ethernet connection to your network (USB-C Ethernet on ATEM Mini Pro)</li>
                  <li>ATEM Software Control installed on any computer on the same network</li>
                </ul>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">Steps</h4>
                <ol className="text-xs text-board-muted space-y-2 list-decimal list-inside">
                  <li>
                    Open <span className="text-board-text font-medium">ATEM Software Control</span> and connect to your ATEM
                  </li>
                  <li>
                    Go to the <span className="text-board-text font-medium">Output</span> tab at the top of the window
                  </li>
                  <li>
                    In the{" "}
                    <span className="text-board-text font-medium">Live Stream</span>{" "}
                    section, select{" "}
                    <span className="text-board-text font-medium">
                      {"Service: Custom"}
                    </span>{" "}
                    from the dropdown
                  </li>
                  <li>
                    <span className="text-board-text font-medium">Server:</span> Copy the <span className="text-amber-400">RTMPS URL</span> from above and paste it here
                  </li>
                  <li>
                    <span className="text-board-text font-medium">Key:</span> Copy the <span className="text-amber-400">Stream Key</span> from above and paste it here
                  </li>
                  <li>
                    Set your preferred <span className="text-board-text font-medium">Quality</span>:
                    <div className="mt-1 ml-4 space-y-0.5">
                      <p className="text-board-muted/70">Streaming High — 1080p 6Mbps (recommended)</p>
                      <p className="text-board-muted/70">Streaming Medium — 720p 4.5Mbps</p>
                      <p className="text-board-muted/70">Streaming Low — 540p 3Mbps (slow internet)</p>
                    </div>
                  </li>
                  <li>
                    Press the <span className="text-board-text font-medium">ON AIR</span> button on the ATEM or click the stream button in ATEM Software Control
                  </li>
                  <li>
                    The status above should change to <span className="text-green-400 font-medium">Connected</span> then <span className="text-green-400 font-medium">Streaming</span> within a few seconds
                  </li>
                </ol>
              </div>

              <div className="px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1">Tip</p>
                <p className="text-xs text-board-muted">
                  Once configured, the ATEM remembers these settings. Next time, just press ON AIR — no computer needed to start streaming.
                  The ATEM's built-in encoder handles everything.
                </p>
              </div>

              <div className="px-3 py-2.5 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400 mb-1">Network Note</p>
                <p className="text-xs text-board-muted">
                  The ATEM must have internet access via its Ethernet port. If your ATEM is on a local-only
                  network, connect it to a port with internet access or use a USB-C Ethernet adapter with an internet-connected port.
                  Minimum recommended: 10 Mbps upload.
                </p>
              </div>
            </div>
          </SetupGuide>

          {/* OBS Studio */}
          <SetupGuide
            id="obs"
            icon={<Monitor className="w-4 h-4" />}
            title="OBS Studio"
            subtitle="Software encoder — capture HDMI/SDI via capture card or screen"
            expanded={expandedGuide === "obs"}
            onToggle={() => setExpandedGuide(expandedGuide === "obs" ? null : "obs")}
          >
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">Steps</h4>
                <ol className="text-xs text-board-muted space-y-2 list-decimal list-inside">
                  <li>
                    Open OBS and go to <span className="text-board-text font-medium">Settings → Stream</span>
                  </li>
                  <li>
                    Set{" "}
                    <span className="text-board-text font-medium">
                      {"Service"}
                    </span>{" "}
                    to{" "}
                    <span className="text-board-text font-medium">Custom...</span>
                  </li>
                  <li>
                    <span className="text-board-text font-medium">Server:</span> Paste the <span className="text-amber-400">RTMPS URL</span> from above
                  </li>
                  <li>
                    <span className="text-board-text font-medium">Stream Key:</span> Paste the <span className="text-amber-400">Stream Key</span> from above
                  </li>
                  <li>
                    Click <span className="text-board-text font-medium">Apply</span>, then close settings
                  </li>
                  <li>
                    Click <span className="text-board-text font-medium">Start Streaming</span> in the main OBS window
                  </li>
                </ol>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">Recommended Output Settings</h4>
                <div className="text-xs text-board-muted space-y-1 ml-2">
                  <p>Encoder: <span className="text-board-text">x264</span> (or NVENC/QSV if available)</p>
                  <p>Rate Control: <span className="text-board-text">CBR</span></p>
                  <p>Bitrate: <span className="text-board-text">4500–6000 Kbps</span> for 1080p</p>
                  <p>Keyframe Interval: <span className="text-board-text">2 seconds</span></p>
                  <p>Profile: <span className="text-board-text">High</span></p>
                </div>
              </div>

              <div className="px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 mb-1">With ATEM + Capture Card</p>
                <p className="text-xs text-board-muted">
                  Connect ATEM HDMI Out → Capture Card → Computer USB. In OBS, add a Video Capture Device source
                  and select your capture card. This gives you OBS's full encoding options while using the ATEM for switching.
                </p>
              </div>
            </div>
          </SetupGuide>

          {/* Stats row */}
          <SetupGuide
            id="hardware"
            icon={<Cable className="w-4 h-4" />}
            title="Hardware Encoder"
            subtitle="Teradek, Kiloview, LiveU, or similar — SDI/HDMI to RTMP"
            expanded={expandedGuide === "hardware"}
            onToggle={() => setExpandedGuide(expandedGuide === "hardware" ? null : "hardware")}
          >
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">General Steps</h4>
                <ol className="text-xs text-board-muted space-y-2 list-decimal list-inside">
                  <li>Connect your video source (ATEM, camera, etc.) to the encoder via SDI or HDMI</li>
                  <li>Connect the encoder to your network via Ethernet</li>
                  <li>Open the encoder's web interface (check your encoder's manual for the IP/URL)</li>
                  <li>Set the streaming destination to <span className="text-board-text font-medium">Custom RTMP</span></li>
                  <li>Paste the <span className="text-amber-400">RTMPS URL</span> as the server address</li>
                  <li>Paste the <span className="text-amber-400">Stream Key</span></li>
                  <li>Start the stream from the encoder's interface or hardware button</li>
                </ol>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-board-text mb-2">SRT (if supported)</h4>
                <p className="text-xs text-board-muted">
                  If your encoder supports SRT (Secure Reliable Transport), use the <span className="text-amber-400">SRT URL</span> instead
                  of RTMP for lower latency and better reliability over unstable networks. SRT is supported by Kiloview, Teradek, and most modern encoders.
                </p>
              </div>

              <div className="px-3 py-2.5 rounded-lg bg-green-500/5 border border-green-500/10">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-green-400 mb-1">Best For</p>
                <p className="text-xs text-board-muted">
                  {workspaceCopy(
                    "\n                  Permanent installations where reliability matters. Hardware encoders are always-on,\n                  don't need a computer, and handle encoding without any lag. Ideal for churches with a fixed production setup.\n                ",
                    workspaceTerms,
                  )}
                </p>
              </div>
            </div>
          </SetupGuide>
        </div>

        {/* How it works */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-2">
            How It Works
          </p>
          <div className="space-y-1.5 text-xs text-board-muted">
            <p>
              <span className="text-board-text font-medium">1. Create a live input</span> — This provisions an ingest point on Cloudflare Stream with RTMPS and SRT URLs.
            </p>
            <p>
              <span className="text-board-text font-medium">2. Configure your encoder</span> — Point your ATEM, OBS, or hardware encoder at the RTMPS URL + stream key.
            </p>
            <p>
              <span className="text-board-text font-medium">3. Go live</span> — Start your encoder. Status updates automatically every 10 seconds.
            </p>
            <p>
              <span className="text-board-text font-medium">4. Simulcast</span> — Go to <span className="text-amber-400">Multi-Platform</span> to push your stream to YouTube, Facebook, Twitch, and more simultaneously.
            </p>
          </div>
        </div>

        {/* Stats row */}
        <Dialog open={showAddForm} onOpenChange={open => { if (!open) void closeEditor(); }}>
          <DialogContent aria-modal="true" showCloseButton={false} className="max-h-[90dvh] overflow-y-auto border-board-border bg-board-card text-board-text">
            <div className="flex items-start justify-between gap-3"><div className="space-y-2"><DialogTitle>New Live Input</DialogTitle><DialogDescription>Create an ingest point for your encoder. Destination forwarding is controlled separately.</DialogDescription></div>
              <button className={controlClass} aria-label="Close live input editor" disabled={busy} onClick={() => void closeEditor()}><X className="size-4" /></button></div>
            <form onSubmit={handleCreate} className="space-y-4">
              <label htmlFor="live-input-name" className="block text-sm">Input Name</label>
              <input id="live-input-name" value={newName} onChange={e => setNewName(e.target.value)} maxLength={200} disabled={locked} placeholder="e.g. ATEM Program, Main Camera" className="min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fire-500" />
              {notice}
              {read.error && <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry inputs" />}
              <div className="flex flex-wrap gap-3"><button type="button" className={controlClass} disabled={busy} onClick={() => void closeEditor()}>Cancel</button><button type="submit" className={controlClass} disabled={controlsDisabled || !newName.trim()}>{busy ? "Creating…" : "Create"}</button></div>
            </form>
          </DialogContent>
        </Dialog>
        <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open && blocker.status === "blocked") blocker.reset(); }}>
          <DialogContent aria-modal="true" showCloseButton={false} className="border-board-border bg-board-card text-board-text"><DialogTitle>Leave Stream?</DialogTitle><DialogDescription>Your draft and retry controls will be discarded. An unconfirmed request may still complete. Review pending inputs when you return.</DialogDescription><div className="flex flex-wrap gap-2"><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.reset()}>Stay</button><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.proceed()}>Leave Stream</button></div></DialogContent>
        </Dialog>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}

/* ─── Copy Field ─────────────────────────────────────────── */

function CopyField({ label, value, fieldId, secret }: { label: string; value: string; fieldId: string; secret?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const generation = useRef(0);
  useEffect(() => { setCopyState("idle"); setRevealed(false); return () => { generation.current++; }; }, [value]);
  const copy = async () => {
    const current = ++generation.current; setCopyState("copying");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([navigator.clipboard.writeText(value), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Copy timed out")), 5_000); })]);
      if (generation.current === current) setCopyState("copied");
    } catch { if (generation.current === current) setCopyState("failed"); }
    finally { clearTimeout(timer); }
  };
  return <div className="min-w-0 space-y-1">
    <span className="text-xs font-medium text-board-muted" id={`${fieldId}-label`}>{label}</span>
    <div className="flex min-w-0 items-center gap-1">
      <code aria-labelledby={`${fieldId}-label`} className="min-w-0 flex-1 select-all truncate rounded-lg bg-board-bg px-2.5 py-2 text-xs text-board-muted">{secret && !revealed ? "••••••••••••••••" : value}</code>
      {secret && <button className={`${controlClass} min-w-11 shrink-0`} aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>}
      <button className={`${controlClass} min-w-11 shrink-0`} disabled={copyState === "copying"} aria-label={`${copyState === "failed" ? "Retry copying" : "Copy"} ${label}`} onClick={() => void copy()}>{copyState === "copied" ? <Check className="size-4 text-green-400" /> : <Copy className="size-4" />}</button>
    </div>
    {copyState === "failed" && <p role="alert" className="text-xs text-amber-200">Could not copy {label}. Retry copying or select the value manually.</p>}
    {copyState === "copied" && <p role="status" className="text-xs text-board-muted">{label} copied.</p>}
  </div>;
}

/* ─── Setup Guide Accordion ─────────────────────────────── */

function SetupGuide({
  id,
  icon,
  title,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-board-border bg-board-card overflow-hidden">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`guide-${id}`}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-board-border/20 transition-colors"
      >
        <div className="p-2 rounded-lg bg-board-bg border border-board-border text-board-muted shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-board-text">{title}</p>
          <p className="text-[11px] text-board-muted truncate">{subtitle}</p>
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-board-muted shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-board-muted shrink-0" />
        )}
      </button>
      {expanded && (
        <div id={`guide-${id}`} className="px-4 pb-4 pt-1 border-t border-board-border">
          {children}
        </div>
      )}
    </div>
  );
}
