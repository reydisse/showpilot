import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useMemo, useState } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Plus,
  Pencil,
  Zap,
  Music,
  Radio,
  Headphones,
  Cable,
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
  PlugZap,
} from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import {
  getMicAssignments,
  addMicAssignment,
  updateMicAssignment,
  deleteMicAssignment,
  getDevices,
} from "@/lib/data";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";

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
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:tm", context.slug, context.orgId);
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const [assignments, devices] = await Promise.all([
      getMicAssignments({ data: { orgId: context.orgId, serviceDate: today } }),
      getDevices({ data: { orgId: context.orgId } }),
    ]);
    return {
      assignments,
      orgId: context.orgId,
      today,
      orgTimezone: settings["org-timezone"],
      mixers: devices.filter((device) => device.category === "mixer"),
    };
  },
  component: AudioPage,
});

function AudioPage() {
  const { assignments: initialAssignments, orgId, today, orgTimezone, mixers } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const [serviceDate, setServiceDate] = useState(today);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [showForm, setShowForm] = useState(false);
  const [editAssignment, setEditAssignment] = useState<typeof assignments[0] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => initialAssignments[0]?.id ?? null);

  const loadAssignments = async (date: string) => {
    setLoading(true);
    const result = await getMicAssignments({ data: { orgId, serviceDate: date } });
    setAssignments(result);
    setLoading(false);
  };

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: (nextToday) => {
      setServiceDate(nextToday);
      void loadAssignments(nextToday);
    },
  });

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
  const enabledMixer = mixers.find((mixer) => mixer.enabled) ?? null;
  const visibleAssignments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assignments;
    return assignments.filter((assignment) => `${assignment.channel} ${assignment.label} ${assignment.micModel} ${assignment.group} ${assignment.notes}`.toLowerCase().includes(needle));
  }, [assignments, query]);
  const selectedAssignment = assignments.find((assignment) => assignment.id === selectedId) ?? assignments[0] ?? null;

  const groupedAssignments = Object.keys(GROUP_CONFIG).reduce(
    (acc, group) => {
      acc[group as ChannelGroup] = visibleAssignments.filter((a) => a.group === group);
      return acc;
    },
    {} as Record<ChannelGroup, typeof visibleAssignments>
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
                  const nextToday = getTodayDateString(orgTimezone);
                  setServiceDate(nextToday);
                  loadAssignments(nextToday);
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

      <div className="mx-auto max-w-[1500px] space-y-4 p-4 md:p-6">
        <div className="grid grid-cols-2 divide-x divide-y divide-board-border overflow-hidden rounded-xl border border-board-border bg-board-card md:grid-cols-4 md:divide-y-0">
          <AudioStat label="Assigned channels" value={assignments.length} icon={SlidersHorizontal} />
          <AudioStat label="Muted" value={mutedCount} icon={MicOff} tone={mutedCount ? "text-red-400" : undefined} />
          <AudioStat label="Phantom power" value={phantomCount} icon={Zap} tone={phantomCount ? "text-yellow-400" : undefined} />
          <AudioStat label="Mixer control" value={enabledMixer ? "Available" : "Not connected"} icon={PlugZap} tone={enabledMixer ? "text-green-400" : "text-board-muted"} />
        </div>
        {!enabledMixer && <div className="flex flex-col gap-3 rounded-xl border border-fire-500/20 bg-fire-500/[0.04] p-4 sm:flex-row sm:items-center"><PlugZap className="h-5 w-5 shrink-0 text-fire-500" /><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-board-text">Connect a mixer for live control</p><p className="mt-1 text-[11px] leading-5 text-board-muted">This page currently stores the service patch, gain notes, phantom and mute state. Add an OSC-compatible mixer to expose verified live controls and feedback.</p></div><Link to="/$slug/dashboard/devices" params={{ slug }} className="shrink-0 rounded-lg border border-fire-500/30 px-3 py-2 text-xs font-semibold text-fire-400 hover:bg-fire-500/10">Configure mixer</Link></div>}
        {loading ? (
          <div className="text-center py-12 text-board-muted text-sm">
            Loading channels...
          </div>
        ) : assignments.length === 0 ? (
          <EmptyState
            icon={Mic}
            title="No channels assigned"
            description="Map mics, instruments and playback inputs to mixer channels for this service."
            action={
              <EmptyStateButton
                onClick={() => {
                  setEditAssignment(null);
                  setShowForm(true);
                }}
              >
                Add First Channel
              </EmptyStateButton>
            }
          />
        ) : (
          <div className="grid overflow-hidden rounded-xl border border-board-border bg-board-card xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 xl:border-r xl:border-board-border"><div className="border-b border-board-border p-3"><label className="relative block max-w-sm"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-board-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search channels" className="w-full rounded-lg border border-board-border bg-board-bg py-2 pl-9 pr-3 text-xs text-board-text outline-none focus:border-fire-500/50" /></label></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] border-collapse text-left"><thead><tr className="border-b border-board-border text-[9px] uppercase tracking-wider text-board-muted"><th className="px-3 py-2.5">Ch</th><th className="px-3 py-2.5">Source</th><th className="px-3 py-2.5">Mic / model</th><th className="px-3 py-2.5">Gain</th><th className="px-3 py-2.5 text-center">48V</th><th className="px-3 py-2.5 text-center">Mute</th><th className="px-3 py-2.5">Notes</th></tr></thead><tbody>{(Object.keys(GROUP_CONFIG) as ChannelGroup[]).flatMap((group) => { const channels = groupedAssignments[group]; if (!channels.length) return []; return [<tr key={`${group}-header`} className="border-b border-board-border bg-board-bg/65"><td colSpan={7} className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-board-muted">{GROUP_CONFIG[group].label} · {channels.length}</td></tr>, ...channels.map((ch) => <tr key={ch.id} onClick={() => setSelectedId(ch.id)} className={`cursor-pointer border-b border-board-border/60 text-xs transition-colors last:border-0 ${selectedAssignment?.id === ch.id ? "bg-fire-500/[0.06]" : "hover:bg-board-bg/45"} ${ch.muted ? "text-board-muted" : "text-board-text"}`}><td className="px-3 py-3 font-mono text-fire-400">{ch.channel}</td><td className="max-w-[180px] truncate px-3 py-3 font-medium">{ch.label}</td><td className="max-w-[170px] truncate px-3 py-3 text-board-muted">{ch.micModel || MIC_TYPE_LABELS[ch.micType as MicType]?.label || "—"}</td><td className="px-3 py-3 font-mono tabular-nums text-board-muted">{ch.gainDb == null ? "—" : `${ch.gainDb > 0 ? "+" : ""}${ch.gainDb} dB`}</td><td className={`px-3 py-3 text-center ${ch.phantom ? "text-yellow-400" : "text-board-muted/30"}`}>{ch.phantom ? "48V" : "—"}</td><td className="px-3 py-2 text-center"><button type="button" onClick={(event) => { event.stopPropagation(); void handleToggleMute(ch.id, ch.muted); }} className={`rounded-lg p-2 ${ch.muted ? "bg-red-500/15 text-red-400" : "text-board-muted hover:bg-board-bg"}`} aria-label={ch.muted ? `Unmute ${ch.label}` : `Mute ${ch.label}`}>{ch.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button></td><td className="max-w-[190px] truncate px-3 py-3 text-board-muted">{ch.notes || "—"}</td></tr>)]})}</tbody></table></div></div>
            {selectedAssignment ? <aside className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] text-board-muted">Channel {selectedAssignment.channel}</p><h2 className="mt-1 text-base font-semibold text-board-text">{selectedAssignment.label}</h2><p className="mt-1 text-xs capitalize text-board-muted">{selectedAssignment.group}</p></div><button type="button" onClick={() => { setEditAssignment(selectedAssignment); setShowForm(true); }} className="rounded-lg border border-board-border p-2 text-board-muted hover:text-board-text" aria-label="Edit channel"><Pencil className="h-3.5 w-3.5" /></button></div><div className="mt-5 space-y-4"><ChannelDetail label="Microphone" value={selectedAssignment.micModel || MIC_TYPE_LABELS[selectedAssignment.micType as MicType]?.label || "Not specified"} /><ChannelDetail label="Stored gain" value={selectedAssignment.gainDb == null ? "Not set" : `${selectedAssignment.gainDb > 0 ? "+" : ""}${selectedAssignment.gainDb} dB`} /><ChannelDetail label="Phantom power" value={selectedAssignment.phantom ? "48V enabled" : "Off"} /><ChannelDetail label="Assignment mute" value={selectedAssignment.muted ? "Muted" : "Open"} /><ChannelDetail label="Notes" value={selectedAssignment.notes || "No notes"} /></div><div className="mt-6 grid gap-2"><button type="button" onClick={() => void handleToggleMute(selectedAssignment.id, selectedAssignment.muted)} className={`rounded-lg px-3 py-2.5 text-xs font-semibold ${selectedAssignment.muted ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>{selectedAssignment.muted ? "Mark unmuted" : "Mark muted"}</button><button type="button" onClick={() => { setEditAssignment(selectedAssignment); setShowForm(true); }} className="rounded-lg border border-board-border px-3 py-2.5 text-xs font-medium text-board-text">Edit assignment</button><button type="button" onClick={() => void handleDelete(selectedAssignment.id)} className="rounded-lg px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10">Delete channel</button></div>{enabledMixer ? <Link to="/$slug/dashboard/devices/$deviceId" params={{ slug, deviceId: enabledMixer.id }} className="mt-6 flex items-center justify-between rounded-xl border border-green-500/20 bg-green-500/[0.04] p-3 text-xs text-green-400"><span>Open {enabledMixer.name} controls</span><ChevronRight className="h-3.5 w-3.5" /></Link> : null}</aside> : null}
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

function AudioStat({ label, value, icon: Icon, tone = "text-board-text" }: { label: string; value: string | number; icon: React.ElementType; tone?: string }) {
  return <div className="flex min-h-[76px] items-center gap-3 px-4 py-3"><Icon className="h-4 w-4 text-board-muted" /><div><p className={`text-base font-semibold tabular-nums ${tone}`}>{value}</p><p className="mt-0.5 text-[10px] text-board-muted">{label}</p></div></div>;
}

function ChannelDetail({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-board-border/60 pb-3 last:border-0"><p className="text-[10px] text-board-muted">{label}</p><p className="mt-1 break-words text-xs text-board-text">{value}</p></div>;
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
