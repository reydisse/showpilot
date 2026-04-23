import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect } from "react";
import {
  Activity,
  Wifi,
  Plus,
  Trash2,
  Copy,
  Check,
  Radio,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Monitor,
  Tv,
  Cable,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";
import {
  getLiveInputs,
  createLiveInput,
  deleteLiveInput,
  getLiveInputStatus,
} from "@/lib/stream";

export const Route = createFileRoute("/$slug/streaming/health")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "stream_health:view", context.slug, context.orgId);
    const inputs = await getLiveInputs({ data: { orgId: context.orgId } });
    return { inputs, orgId: context.orgId };
  },
  component: StreamHealthPage,
});

function StreamHealthPage() {
  const { inputs, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  // Poll statuses
  useEffect(() => {
    if (inputs.length === 0) return;

    const pollStatuses = async () => {
      setPolling(true);
      for (const input of inputs) {
        try {
          const result = await getLiveInputStatus({
            data: { orgId, inputId: input.id },
          });
          if (result) {
            setStatuses((prev) => ({ ...prev, [input.id]: result.status }));
          }
        } catch {
          // Silently continue
        }
      }
      setPolling(false);
    };

    pollStatuses();
    const interval = setInterval(pollStatuses, 10000);
    return () => clearInterval(interval);
  }, [inputs, orgId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError("");

    try {
      await createLiveInput({ data: { orgId, name: newName.trim() } });
      setNewName("");
      setShowAddForm(false);
      router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create input");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (inputId: string) => {
    await deleteLiveInput({ data: { orgId, inputId } });
    router.invalidate();
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const liveCount = inputs.filter(
    (i) => (statuses[i.id] ?? i.status) === "streaming"
  ).length;
  const connectedCount = inputs.filter(
    (i) => (statuses[i.id] ?? i.status) !== "idle"
  ).length;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 md:px-6 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Stream Health
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Live inputs, encoder setup, and health monitoring
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            {polling && (
              <RefreshCw className="w-3.5 h-3.5 text-board-muted animate-spin" />
            )}
            {canManageStreamHealth && (
              <button
                onClick={() => setShowAddForm(true)}
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
              {liveCount > 0 ? "Live" : "Offline"}
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
              {connectedCount}
            </p>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Live inputs list */}
        {inputs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-board-border p-12 text-center">
            <Activity className="w-10 h-10 text-board-muted/20 mx-auto mb-3" />
            <p className="text-sm font-medium text-board-muted mb-1">
              No live inputs configured
            </p>
            <p className="text-xs text-board-muted/50 mb-4">
              Create a Cloudflare Stream live input to start receiving video from your encoder
            </p>
            {canManageStreamHealth && (
              <button
                onClick={() => setShowAddForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-fire-500 text-white text-sm font-semibold hover:bg-fire-600 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Live Input
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {inputs.map((input) => {
              const status = statuses[input.id] ?? input.status;
              const isLive = status === "streaming";
              const isConnected = status === "connected";

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
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-3 h-3 rounded-full ${
                          isLive
                            ? "bg-green-500 animate-pulse"
                            : isConnected
                              ? "bg-blue-500"
                              : "bg-board-muted"
                        }`}
                      />
                      <div>
                        <p className="text-sm font-semibold text-board-text">
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
                          {isLive ? "Streaming" : isConnected ? "Connected" : "Idle"}
                        </span>
                      </div>
                    </div>
                    {canManageStreamHealth && (
                      <button
                        onClick={() => handleDelete(input.id)}
                        className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Connection details */}
                  <div className="space-y-2">
                    {input.rtmpUrl && (
                      <CopyField
                        label="RTMPS URL"
                        value={input.rtmpUrl}
                        fieldId={`rtmp-${input.id}`}
                        copiedField={copiedField}
                        onCopy={copyToClipboard}
                      />
                    )}
                    {input.rtmpKey && (
                      <CopyField
                        label="Stream Key"
                        value={input.rtmpKey}
                        fieldId={`key-${input.id}`}
                        copiedField={copiedField}
                        onCopy={copyToClipboard}
                        secret
                      />
                    )}
                    {input.srtUrl && (
                      <CopyField
                        label="SRT URL"
                        value={input.srtUrl}
                        fieldId={`srt-${input.id}`}
                        copiedField={copiedField}
                        onCopy={copyToClipboard}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Encoder Setup Guides */}
        <div className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 px-1">
            Encoder Setup Guides
          </p>

          {/* ATEM Mini Pro / ISO */}
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
                    In the <span className="text-board-text font-medium">Live Stream</span> section, select <span className="text-board-text font-medium">Service: Custom</span> from the dropdown
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
                    Set <span className="text-board-text font-medium">Service</span> to <span className="text-board-text font-medium">Custom...</span>
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

          {/* Hardware Encoder */}
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
                  Permanent installations where reliability matters. Hardware encoders are always-on,
                  don't need a computer, and handle encoding without any lag. Ideal for churches with a fixed production setup.
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

        {/* Add form modal */}
        {showAddForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-semibold text-board-text">
                  New Live Input
                </h2>
                <button
                  onClick={() => {
                    setShowAddForm(false);
                    setError("");
                  }}
                  className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
                >
                  ✕
                </button>
              </div>
              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-sm text-board-muted mb-1.5">
                    Input Name
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. ATEM Program, Main Camera"
                    className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors text-sm"
                    autoFocus
                  />
                </div>
                {error && <p className="text-red-400 text-sm">{error}</p>}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setError("");
                    }}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-board-muted hover:bg-board-border transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newName.trim()}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
                  >
                    {creating ? "Creating..." : "Create"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Copy Field ─────────────────────────────────────────── */

function CopyField({
  label,
  value,
  fieldId,
  copiedField,
  onCopy,
  secret,
}: {
  label: string;
  value: string;
  fieldId: string;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const displayValue = secret && !revealed ? "••••••••••••••••" : value;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium text-board-muted uppercase tracking-wider w-20 shrink-0">
        {label}
      </span>
      <code
        className="flex-1 text-[11px] text-board-muted bg-board-bg px-2.5 py-1.5 rounded-lg truncate font-mono select-all"
      >
        {displayValue}
      </code>
      {secret && (
        <button
          onClick={() => setRevealed(!revealed)}
          className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? (
            <EyeOff className="w-3.5 h-3.5" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
        </button>
      )}
      <button
        onClick={() => onCopy(value, fieldId)}
        className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
        title="Copy to clipboard"
      >
        {copiedField === fieldId ? (
          <Check className="w-3.5 h-3.5 text-green-400" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
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
        <div className="px-4 pb-4 pt-1 border-t border-board-border">
          {children}
        </div>
      )}
    </div>
  );
}
