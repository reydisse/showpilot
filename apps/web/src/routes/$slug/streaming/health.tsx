import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Activity,
  Wifi,
  WifiOff,
  Plus,
  Trash2,
  Copy,
  Check,
  Radio,
  AlertTriangle,
} from "lucide-react";
import {
  getLiveInputs,
  createLiveInput,
  deleteLiveInput,
  getLiveInputStatus,
} from "@/lib/stream";

export const Route = createFileRoute("/$slug/streaming/health")({
  loader: async ({ context }) => {
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

  // Poll statuses
  useEffect(() => {
    if (inputs.length === 0) return;

    const pollStatuses = async () => {
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
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Stream Health
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Cloudflare Stream live inputs and health monitoring
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Input
          </button>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
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
              Create a Cloudflare Stream live input to get started
            </p>
            <button
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-fire-500 text-white text-sm font-semibold hover:bg-fire-600 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Live Input
            </button>
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
                    <button
                      onClick={() => handleDelete(input.id)}
                      className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
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

        {/* Info box */}
        <div className="rounded-xl border border-board-border bg-board-card/50 p-4">
          <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50 mb-2">
            How It Works
          </p>
          <div className="space-y-1.5 text-xs text-board-muted">
            <p>
              Live inputs are created on Cloudflare Stream. Point your encoder
              (OBS, vMix, hardware) at the RTMPS URL + stream key.
            </p>
            <p>
              Status is polled automatically. Connect destinations on the
              Multi-Platform page to simulcast.
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
                    placeholder="e.g. Main Camera, Worship Feed"
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
        className="flex-1 text-[11px] text-board-muted bg-board-bg px-2.5 py-1.5 rounded-lg truncate cursor-pointer"
        onClick={() => secret && setRevealed(!revealed)}
        title={secret ? "Click to reveal" : undefined}
      >
        {displayValue}
      </code>
      <button
        onClick={() => onCopy(value, fieldId)}
        className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
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
