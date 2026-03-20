import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Plus,
  Pencil,
  Trash2,
  Zap,
  Music,
  Radio,
  Headphones,
  Cable,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  getMicAssignments,
  addMicAssignment,
  updateMicAssignment,
  deleteMicAssignment,
} from "@/lib/data";
import { getTodayDateString } from "@/lib/utils";

type MicType = "wireless-handheld" | "wireless-lav" | "wired" | "headset" | "di-box" | "other";
type ChannelGroup = "vocals" | "band" | "playback" | "sfx" | "other";

const MIC_TYPE_LABELS: Record<MicType, { label: string; icon: React.ElementType }> = {
  "wireless-handheld": { label: "Wireless Handheld", icon: Mic },
  "wireless-lav": { label: "Wireless Lav", icon: Radio },
  wired: { label: "Wired", icon: Cable },
  headset: { label: "Headset", icon: Headphones },
  "di-box": { label: "DI Box", icon: Zap },
  other: { label: "Other", icon: Mic },
};

const GROUP_CONFIG: Record<ChannelGroup, { label: string; icon: React.ElementType; color: string }> = {
  vocals: { label: "Vocals", icon: Mic, color: "text-blue-400" },
  band: { label: "Band", icon: Music, color: "text-purple-400" },
  playback: { label: "Playback", icon: Headphones, color: "text-green-400" },
  sfx: { label: "SFX", icon: Zap, color: "text-yellow-400" },
  other: { label: "Other", icon: Cable, color: "text-board-muted" },
};

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export const Route = createFileRoute("/$slug/dashboard/audio")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const today = getTodayDateString();
    const assignments = await getMicAssignments({
      data: { orgId: context.orgId, serviceDate: today },
    });
    return { assignments, orgId: context.orgId, today };
  },
  component: AudioPage,
});

function AudioPage() {
  const { assignments: initialAssignments, orgId, today } = Route.useLoaderData();
  const router = useRouter();
  const [serviceDate, setServiceDate] = useState(today);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [showForm, setShowForm] = useState(false);
  const [editAssignment, setEditAssignment] = useState<typeof assignments[0] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadAssignments = async (date: string) => {
    setLoading(true);
    const result = await getMicAssignments({ data: { orgId, serviceDate: date } });
    setAssignments(result);
    setLoading(false);
  };

  const handleDateChange = (days: number) => {
    const newDate = shiftDate(serviceDate, days);
    setServiceDate(newDate);
    loadAssignments(newDate);
  };

  const handleToggleMute = async (id: string, currentMuted: boolean) => {
    await updateMicAssignment({ data: { id, updates: { muted: !currentMuted } } });
    loadAssignments(serviceDate);
  };

  const handleDelete = async (id: string) => {
    await deleteMicAssignment({ data: { id } });
    loadAssignments(serviceDate);
  };

  const phantomCount = assignments.filter((a) => a.phantom).length;
  const mutedCount = assignments.filter((a) => a.muted).length;

  const groupedAssignments = Object.keys(GROUP_CONFIG).reduce(
    (acc, group) => {
      acc[group as ChannelGroup] = assignments.filter((a) => a.group === group);
      return acc;
    },
    {} as Record<ChannelGroup, typeof assignments>
  );

  const nextChannel =
    assignments.length > 0 ? Math.max(...assignments.map((a) => a.channel)) + 1 : 1;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Audio
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Mic assignments and channel management
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleDateChange(-1)}
                className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  setServiceDate(today);
                  loadAssignments(today);
                }}
                className="px-3 py-1 rounded-lg text-xs font-medium text-board-text hover:bg-board-border/50 transition-colors"
              >
                {formatDisplayDate(serviceDate)}
              </button>
              <button
                onClick={() => handleDateChange(1)}
                className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={() => {
                setEditAssignment(null);
                setShowForm(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Channel
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto space-y-5">
        {/* Summary strip */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-fire-500" />
            <span className="text-sm font-medium text-board-text">
              {assignments.length} channel{assignments.length !== 1 ? "s" : ""}
            </span>
          </div>
          {mutedCount > 0 && (
            <div className="flex items-center gap-1.5 text-red-400">
              <MicOff className="w-3.5 h-3.5" />
              <span className="text-xs">{mutedCount} muted</span>
            </div>
          )}
          {phantomCount > 0 && (
            <div className="flex items-center gap-1.5 text-yellow-400">
              <Zap className="w-3.5 h-3.5" />
              <span className="text-xs">{phantomCount} phantom</span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="text-center py-12 text-board-muted text-sm">
            Loading channels...
          </div>
        ) : assignments.length === 0 ? (
          <div className="text-center py-16">
            <Mic className="w-12 h-12 text-board-muted/20 mx-auto mb-3" />
            <p className="text-board-muted mb-1">No channels assigned</p>
            <p className="text-board-muted/60 text-xs mb-4">
              Add mic and input assignments for this service
            </p>
            <button
              onClick={() => {
                setEditAssignment(null);
                setShowForm(true);
              }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 transition-colors text-sm"
            >
              <Plus className="w-4 h-4" />
              Add First Channel
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {(Object.keys(GROUP_CONFIG) as ChannelGroup[]).map((group) => {
              const channels = groupedAssignments[group];
              if (channels.length === 0) return null;
              const config = GROUP_CONFIG[group];
              const Icon = config.icon;

              return (
                <div key={group}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                    <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                      {config.label}
                    </span>
                    <span className="text-[10px] text-board-muted/50 tabular-nums">
                      {channels.length} ch
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {channels.map((ch) => {
                      const micConfig = MIC_TYPE_LABELS[ch.micType as MicType] ?? MIC_TYPE_LABELS.other;
                      return (
                        <div
                          key={ch.id}
                          className={`rounded-xl border p-4 transition-colors ${
                            ch.muted
                              ? "bg-red-500/5 border-red-500/15 opacity-60"
                              : "bg-board-card border-board-border hover:border-board-muted/30"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                                ch.muted
                                  ? "bg-red-500/20 text-red-400"
                                  : "bg-fire-500/15 text-fire-500"
                              }`}
                            >
                              {ch.channel}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium text-board-text truncate">
                                  {ch.label}
                                </p>
                                {ch.phantom && (
                                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400 uppercase">
                                    48V
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] font-medium text-board-muted uppercase tracking-wider">
                                  {micConfig.label}
                                </span>
                                {ch.micModel && (
                                  <>
                                    <span className="text-board-border">·</span>
                                    <span className="text-[10px] text-board-muted truncate">
                                      {ch.micModel}
                                    </span>
                                  </>
                                )}
                              </div>
                              {ch.gainDb !== null && (
                                <div className="flex items-center gap-1.5 mt-1.5">
                                  <Volume2 className="w-3 h-3 text-board-muted" />
                                  <div className="flex-1 h-1.5 rounded-full bg-board-border overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all ${
                                        ch.gainDb > 0
                                          ? "bg-red-400"
                                          : ch.gainDb > -6
                                            ? "bg-yellow-400"
                                            : "bg-green-400"
                                      }`}
                                      style={{
                                        width: `${Math.min(100, Math.max(5, ((ch.gainDb + 40) / 50) * 100))}%`,
                                      }}
                                    />
                                  </div>
                                  <span className="text-[10px] font-mono text-board-muted tabular-nums w-10 text-right">
                                    {ch.gainDb > 0 ? "+" : ""}
                                    {ch.gainDb} dB
                                  </span>
                                </div>
                              )}
                              {ch.notes && (
                                <p className="text-[10px] text-board-muted/60 mt-1.5 truncate">
                                  {ch.notes}
                                </p>
                              )}
                            </div>

                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <button
                                onClick={() => handleToggleMute(ch.id, ch.muted)}
                                className={`p-2 rounded-lg transition-colors ${
                                  ch.muted
                                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                    : "text-board-muted hover:bg-board-border/50 hover:text-board-text"
                                }`}
                                title={ch.muted ? "Unmute" : "Mute"}
                              >
                                {ch.muted ? (
                                  <VolumeX className="w-4 h-4" />
                                ) : (
                                  <Volume2 className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={() => {
                                  setEditAssignment(ch);
                                  setShowForm(true);
                                }}
                                className="p-2 rounded-lg text-board-muted hover:bg-board-border/50 hover:text-board-text transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDelete(ch.id)}
                                className="p-2 rounded-lg text-board-muted hover:bg-red-500/20 hover:text-red-400 transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showForm && (
          <MicAssignmentForm
            existing={editAssignment}
            orgId={orgId}
            serviceDate={serviceDate}
            nextChannel={nextChannel}
            onClose={() => {
              setShowForm(false);
              setEditAssignment(null);
            }}
            onSaved={() => {
              setShowForm(false);
              setEditAssignment(null);
              loadAssignments(serviceDate);
            }}
          />
        )}
      </div>
    </div>
  );
}

function MicAssignmentForm({
  existing,
  orgId,
  serviceDate,
  nextChannel,
  onClose,
  onSaved,
}: {
  existing: Awaited<ReturnType<typeof getMicAssignments>>[0] | null;
  orgId: string;
  serviceDate: string;
  nextChannel: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [channel, setChannel] = useState(existing?.channel ?? nextChannel);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [micType, setMicType] = useState<MicType>(
    (existing?.micType as MicType) ?? "wireless-handheld"
  );
  const [micModel, setMicModel] = useState(existing?.micModel ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [gainDb, setGainDb] = useState<number | "">(existing?.gainDb ?? "");
  const [phantom, setPhantom] = useState(existing?.phantom ?? false);
  const [group, setGroup] = useState<ChannelGroup>(
    (existing?.group as ChannelGroup) ?? "vocals"
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setSaving(true);

    if (existing) {
      await updateMicAssignment({
        data: {
          id: existing.id,
          updates: {
            channel,
            label: label.trim(),
            micType,
            micModel: micModel.trim(),
            notes: notes.trim(),
            gainDb: gainDb === "" ? null : gainDb,
            phantom,
            group,
          },
        },
      });
    } else {
      await addMicAssignment({
        data: {
          orgId,
          channel,
          label: label.trim(),
          micType,
          micModel: micModel.trim(),
          notes: notes.trim(),
          gainDb: gainDb === "" ? null : gainDb,
          phantom,
          group,
          serviceDate,
        },
      });
    }

    setSaving(false);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-board-text">
            {existing ? "Edit Channel" : "Add Channel"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Channel #</label>
              <input
                type="number"
                min={1}
                value={channel}
                onChange={(e) => setChannel(Number(e.target.value))}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors tabular-nums"
              />
            </div>
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Group</label>
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value as ChannelGroup)}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors appearance-none"
              >
                <option value="vocals">Vocals</option>
                <option value="band">Band</option>
                <option value="playback">Playback</option>
                <option value="sfx">SFX</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-board-muted mb-1.5">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Pastor James, Kick Drum, Keys L"
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Mic Type</label>
              <select
                value={micType}
                onChange={(e) => setMicType(e.target.value as MicType)}
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors appearance-none"
              >
                <option value="wireless-handheld">Wireless Handheld</option>
                <option value="wireless-lav">Wireless Lav</option>
                <option value="wired">Wired</option>
                <option value="headset">Headset</option>
                <option value="di-box">DI Box</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Mic / Model</label>
              <input
                type="text"
                value={micModel}
                onChange={(e) => setMicModel(e.target.value)}
                placeholder="e.g. Shure SM58"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-board-muted mb-1.5">Gain (dB)</label>
              <input
                type="number"
                value={gainDb}
                onChange={(e) =>
                  setGainDb(e.target.value ? Number(e.target.value) : "")
                }
                placeholder="-10"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors tabular-nums"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={phantom}
                  onChange={(e) => setPhantom(e.target.checked)}
                  className="w-4 h-4 rounded border-board-border accent-fire-500"
                />
                <span className="text-sm text-board-muted">48V Phantom</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm text-board-muted mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. needs new battery, pad -10dB"
              rows={2}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors resize-none"
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
              disabled={saving || !label.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-fire-500 text-white font-semibold hover:bg-fire-600 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : existing ? "Update" : "Add Channel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
