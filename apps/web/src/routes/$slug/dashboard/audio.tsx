import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Mic, MicOff, Volume2, VolumeX, Plus, Pencil, Zap, Music, Radio, Headphones, Cable, ChevronRight, Search, SlidersHorizontal, PlugZap, X } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { RouteError } from "@/components/ui/RouteRecovery";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { getMicAssignments, addMicAssignment, updateMicAssignment, deleteMicAssignment, getDevices } from "@/lib/data";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { ShowSwitcherMenu, type ShowSwitcherOption } from "@/components/show-switcher-menu";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ConfirmedWriteNotice as WriteNotice } from "@/components/layout/ConfirmedWriteNotice";
import { useConfirmedWrite } from "@/hooks/useConfirmedWrite";
import { getRundownOpeningDate } from "@/lib/rundown";
import { createBrowserId } from "@/lib/browser-id";

type MicType =
  | "wireless-handheld"
  | "wireless-lav"
  | "wired"
  | "headset"
  | "di-box"
  | "other";
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

export const Route = createFileRoute("/$slug/dashboard/audio")({
  errorComponent: RouteError,
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, abortController }) => {
    const signal = abortController.signal;
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:tm", context.slug, context.orgId);
    return loadAudio(context.orgId, signal);
  },
  component: AudioPage,
});

async function loadAudio(orgId: string, signal: AbortSignal) {
    const settings = await getOrgSettings({ data: { orgId: orgId }, signal });
    const today = getTodayDateString(settings["org-timezone"]);
    const opening = await getRundownOpeningDate({ data: { orgId: orgId, today }, signal });
    const [assignments, devices] = await Promise.all([
      getMicAssignments({ data: { orgId: orgId, serviceDate: opening.serviceDate, showId: opening.showId }, signal }),
      getDevices({ data: { orgId: orgId }, signal }),
    ]);
    return {
      assignments,
      orgId: orgId,
      initialServiceDate: opening.serviceDate,
      initialShowId: opening.showId ?? null,
      shows: opening.shows,
      orgTimezone: settings["org-timezone"],
      mixers: devices.filter((device) => device.category === "mixer"),
    };
}

type Assignment = Awaited<ReturnType<typeof getMicAssignments>>[number];
type AudioInitial = Awaited<ReturnType<typeof loadAudio>>;
type AudioDraft = Pick<Assignment, "channel" | "label" | "micType" | "micModel" | "notes" | "gainDb" | "phantom" | "group">;
const controlClass = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

function AudioPage() {
  const initial = Route.useLoaderData();
  return <AudioWorkspace key={initial.orgId} initial={initial} />;
}
export function AudioWorkspace({ initial }: { initial: AudioInitial }) {
  const [selection, setSelection] = useState({ id: initial.initialShowId, serviceDate: initial.initialServiceDate });
  return <AudioShow key={JSON.stringify(selection)} initial={initial} selection={selection} selectShow={setSelection} />;
}
function AudioShow({ initial, selection, selectShow }: {
  initial: AudioInitial;
  selection: { id: string | null; serviceDate: string };
  selectShow: (selection: { id: string | null; serviceDate: string }) => void;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const { slug } = Route.useParams();
  const { orgId, shows, orgTimezone, mixers } = initial;
  const { id: showId, serviceDate } = selection;
  const scope = JSON.stringify([orgId, showId, serviceDate]);
  const readChannels = useCallback((signal: AbortSignal) => getMicAssignments({ data: { orgId, serviceDate, showId: showId ?? undefined }, signal }), [orgId, serviceDate, showId]);
  const read = useOperatorRead<Assignment[] | null>({ key: scope,
    initialValue: initial.initialShowId === showId && initial.initialServiceDate === serviceDate ? initial.assignments : null,
    read: readChannels, errorMessage: "Could not refresh channels. Previously confirmed assignments are kept. Retry to see the current patch.",
  });
  const assignments = read.value ?? [];
  const loading = read.value === null && !read.error;
  const writes = useConfirmedWrite(scope);
  const writeLocked = writes.state.status !== "idle";
  const busy = writes.state.status === "saving";
  const controlsDisabled = writeLocked || read.value === null || !!read.error || read.refreshing;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedAssignment = assignments.find(row => row.id === selectedId) ?? assignments[0] ?? null;
  const [editor, setEditor] = useState<{ key: string; assignment: Assignment | null; open: boolean } | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const dirty = writeLocked || formDirty;
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  useEffect(() => { if (!dirty && blocker.status === "blocked") blocker.proceed(); }, [dirty, blocker]);
  const changeShow = async (next: Pick<ShowSwitcherOption, "id" | "serviceDate">) => {
    if (dirty && !await confirm({ title: "Leave this audio patch?", description: "Unsaved drafts and retry controls will be discarded. An unconfirmed change may still complete; review this show when you return.", confirmLabel: "Leave patch" })) return;
    selectShow(next);
  };
  useServiceDateRollover({ serviceDate, timeZone: orgTimezone, onTodayChanged: nextToday => {
    if (dirty) return;
    const next = shows.find(show => show.serviceDate === nextToday);
    selectShow({ id: next?.id ?? null, serviceDate: nextToday });
  } });
  const openEditor = (assignment: Assignment | null) => {
    if (controlsDisabled) return;
    setFormDirty(false); setEditor({ key: createBrowserId(), assignment, open: true });
  };
  const closeEditor = async () => {
    if (busy) return;
    if (writeLocked) { setEditor(current => current ? { ...current, open: false } : null); return; }
    if (formDirty && !await confirm({ title: "Discard channel draft?", description: "Your unsaved channel fields will be discarded.", confirmLabel: "Discard draft" })) return;
    setEditor(null); setFormDirty(false);
  };
  const startChange = (label: string, write: (requestId: string, signal: AbortSignal) => Promise<unknown>, closeForm = false) => writes.start({
    label, write,
    finish: async (_result, signal) => {
      const confirmed = await read.refresh();
      signal.throwIfAborted();
      if (!confirmed) throw new Error("The change was saved, but the channel list could not be refreshed. Retry refresh without repeating the save.");
      if (closeForm) { setEditor(null); setFormDirty(false); }
    },
    apply: () => read.invalidate(),
  });
  const reviewStored = async () => {
    if (reviewing || writes.state.status !== "failed") return;
    if (!await confirm({ title: "Review stored channels?", description: "The previous request may already have saved. Refresh the patch before editing again. Your open form draft will be kept.", confirmLabel: "Review channels", variant: "warning" })) return;
    setReviewing(true);
    if (await read.refresh()) writes.discard();
    setReviewing(false);
  };
  const handleToggleMute = (assignment: Assignment) => startChange(assignment.muted ? "Mark unmuted" : "Mark muted",
    (requestId, signal) => updateMicAssignment({ data: { orgId, id: assignment.id, requestId, updates: { muted: !assignment.muted } }, signal }));
  const handleDelete = async (assignment: Assignment) => {
    if (controlsDisabled || !await confirm({ title: "Delete channel?", description: `Remove channel ${assignment.channel} (${assignment.label}) from this show's audio patch? This does not change the physical mixer or other shows.`, confirmLabel: "Delete channel" })) return;
    await startChange("Delete channel", (requestId, signal) => deleteMicAssignment({ data: { orgId, id: assignment.id, requestId }, signal }));
  };
  const saveDraft = (draft: AudioDraft) => {
    if (!editor || writeLocked) return;
    const existing = editor.assignment;
    if (existing) void startChange("Update channel", (requestId, signal) => updateMicAssignment({ data: { orgId, id: existing.id, requestId, updates: draft }, signal }), true);
    else if (showId) void startChange("Add channel", (requestId, signal) => addMicAssignment({ data: { orgId, showId, serviceDate, requestId, ...draft }, signal }), true);
  };
  const visibleAssignments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assignments.filter(row => `${row.channel} ${row.label} ${row.micModel} ${row.group} ${row.notes}`.toLowerCase().includes(needle));
  }, [assignments, query]);
  const groups = Object.entries(GROUP_CONFIG).map(([key, config]) => ({ key, label: config.label,
    rows: visibleAssignments.filter(row => (Object.hasOwn(GROUP_CONFIG, row.group) ? row.group : "other") === key),
  })).filter(group => group.rows.length > 0);
  const enabledMixer = mixers.find(mixer => mixer.enabled);
  const notice = <><WriteNotice collectionLabel="channels" state={writes.state} retry={() => void writes.retry()} review={() => void reviewStored()} reviewing={reviewing} />{editor?.open && read.error && <p role="alert" className="text-sm text-amber-200">{read.error.message}</p>}</>;
  const muteButton = (row: Assignment) => <button type="button" disabled={controlsDisabled} onClick={() => void handleToggleMute(row)} className={`${controlClass} min-w-11 ${row.muted ? "text-red-400" : "text-board-muted"}`} aria-label={`${row.muted ? "Mark unmuted" : "Mark muted"}: ${row.label}`}>
    {row.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
  </button>;
  const selectButton = (row: Assignment) => <button type="button" aria-pressed={selectedAssignment?.id === row.id} onClick={() => setSelectedId(row.id)} className="min-h-11 min-w-0 max-w-full break-words rounded-lg px-2 py-2 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-fire-500" aria-label={`Inspect channel ${row.channel}: ${row.label}`}>{row.label}</button>;

  return <div className="h-full min-w-0 overflow-auto">
    {ConfirmDialogEl}
    <div className="sticky top-0 z-10 border-b border-board-border bg-board-bg/95 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h1 className="text-lg font-semibold text-board-text">Audio</h1><p className="mt-0.5 text-xs text-board-muted">Mic assignments and channel management</p></div>
        <div className="flex flex-wrap items-center gap-2 [&_button]:min-h-11">
          <ShowSwitcherMenu selectedId={showId} shows={shows} timeZone={orgTimezone} onSelect={next => void changeShow(next)} />
          {read.value && assignments.length > 0 && <button disabled={!showId || controlsDisabled} onClick={() => openEditor(null)} className={`${controlClass} bg-fire-500 text-black`}><Plus className="mr-1 inline h-3 w-3" />Add Channel</button>}
        </div>
      </div>
    </div>
    <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry channels" />
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 md:p-6">
      {!editor?.open && notice}
      {editor && !editor.open && <button className={controlClass} onClick={() => setEditor({ ...editor, open: true })}>Review channel draft</button>}
      {read.refreshing && read.value !== null && <p role="status" className="text-xs text-board-muted">Refreshing channels… Previously confirmed values are shown.</p>}
      <div className="grid grid-cols-2 divide-x divide-y divide-board-border overflow-hidden rounded-xl border border-board-border bg-board-card md:grid-cols-4 md:divide-y-0">
        <AudioStat label="Assigned channels" value={assignments.length} icon={SlidersHorizontal} />
        <AudioStat label="Muted" value={assignments.filter(row => row.muted).length} icon={MicOff} />
        <AudioStat label="Phantom power" value={assignments.filter(row => row.phantom).length} icon={Zap} />
        <AudioStat label="Mixer control" value={enabledMixer ? "Available" : "Not connected"} icon={PlugZap} />
      </div>
      {!enabledMixer && <div className="flex flex-col gap-3 rounded-xl border border-fire-500/20 bg-fire-500/[0.04] p-4 sm:flex-row sm:items-center">
        <PlugZap className="h-5 w-5 shrink-0 text-fire-500" /><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-board-text">Connect a mixer for live control</p><p className="mt-1 text-xs leading-5 text-board-muted">{workspaceCopy("This page stores the service patch, gain notes, phantom and mute state. Marking an assignment muted does not mute the physical mixer. Open a connected mixer's device controls for live changes.", workspaceTerms)}</p></div>
        <Link to="/$slug/dashboard/devices" params={{ slug }} className={controlClass}>Configure mixer</Link>
      </div>}
      {loading ? <p role="status" className="py-12 text-center text-sm text-board-muted">Loading channels…</p>
        : read.value === null ? null
        : assignments.length === 0 ? <EmptyState icon={Mic} title="No channels assigned" description={workspaceCopy("Map mics, instruments and playback inputs to mixer channels for this service.", workspaceTerms)} action={showId ? <EmptyStateButton disabled={controlsDisabled} onClick={() => openEditor(null)}>Add First Channel</EmptyStateButton> : undefined} />
        : <div className="grid min-w-0 overflow-hidden rounded-xl border border-board-border bg-board-card 2xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 2xl:border-r 2xl:border-board-border">
            <div className="border-b border-board-border p-3"><label className="relative block max-w-sm"><span className="sr-only">Search channels</span><Search className="absolute left-3 top-4 h-3.5 w-3.5 text-board-muted" /><input aria-label="Search channels" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search channels" className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg py-2 pl-9 pr-3 text-sm text-board-text outline-none focus:border-fire-500" /></label></div>
            {!visibleAssignments.length ? <div className="p-5 text-sm text-board-muted"><p>No channels match your search.</p><button className={`${controlClass} mt-3`} onClick={() => setQuery("")}>Clear search</button></div> : <>
              <div className="divide-y divide-board-border xl:hidden">{groups.map(group => <section key={group.key}><h3 className="bg-board-bg/65 px-3 py-2 text-xs font-semibold text-board-muted">{group.label} · {group.rows.length}</h3>{group.rows.map(row => <div key={row.id} className={`min-w-0 p-3 ${selectedAssignment?.id === row.id ? "bg-fire-500/[0.06]" : ""}`}>
                <div className="flex min-w-0 items-center gap-2"><span className="shrink-0 font-mono text-xs text-fire-400">Ch {row.channel}</span><div className="min-w-0 flex-1">{selectButton(row)}</div>{muteButton(row)}</div>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-board-muted">Microphone</dt><dd className="break-words">{row.micModel || MIC_TYPE_LABELS[row.micType as MicType]?.label || row.micType}</dd></div><div><dt className="text-board-muted">Gain / 48V / mute</dt><dd>{row.gainDb ?? "—"} dB · {row.phantom ? "48V" : "Off"} · {row.muted ? "Muted" : "Open"}</dd></div></dl>
                <p className="mt-2 break-words text-xs text-board-muted">{row.notes || "No notes"}</p>
              </div>)}</section>)}</div>
              <table className="hidden w-full table-fixed border-collapse text-left xl:table"><thead><tr className="border-b border-board-border text-[10px] uppercase text-board-muted"><th className="w-12 px-2 py-3">Ch</th><th className="w-[22%] px-2">Source</th><th className="w-[20%] px-2">Mic / model</th><th className="w-20 px-2">Gain</th><th className="w-12 px-2">48V</th><th className="w-16 px-2">Mute</th><th className="px-2">Notes</th></tr></thead>
                <tbody>{groups.map(group => <Fragment key={group.key}><tr className="bg-board-bg/65"><th colSpan={7} className="px-3 py-2 text-xs font-semibold text-board-muted">{group.label} · {group.rows.length}</th></tr>{group.rows.map(row => <tr key={row.id} className={`border-b border-board-border text-xs ${selectedAssignment?.id === row.id ? "bg-fire-500/[0.06]" : ""}`}>
                  <td className="px-2 font-mono text-fire-400">{row.channel}</td><td>{selectButton(row)}</td><td className="break-words px-2">{row.micModel || MIC_TYPE_LABELS[row.micType as MicType]?.label || row.micType}</td><td className="px-2">{row.gainDb ?? "—"} dB</td><td className="px-2">{row.phantom ? "48V" : "—"}</td><td>{muteButton(row)}</td><td className="break-words px-2">{row.notes || "—"}</td>
                </tr>)}</Fragment>)}</tbody>
              </table>
            </>}
          </div>
          {selectedAssignment && <aside aria-label="Selected channel" className="min-w-0 border-t border-board-border p-5 2xl:border-t-0">
            <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="text-xs text-board-muted">Channel {selectedAssignment.channel}</p><h2 className="mt-1 break-words text-base font-semibold text-board-text">{selectedAssignment.label}</h2><p className="mt-1 text-xs text-board-muted">{GROUP_CONFIG[selectedAssignment.group as ChannelGroup]?.label ?? selectedAssignment.group}</p></div><button disabled={controlsDisabled} onClick={() => openEditor(selectedAssignment)} className={`${controlClass} min-w-11`} aria-label="Edit channel"><Pencil className="h-4 w-4" /></button></div>
            <div className="mt-5 space-y-4"><ChannelDetail label="Microphone" value={selectedAssignment.micModel || MIC_TYPE_LABELS[selectedAssignment.micType as MicType]?.label || "Not specified"} /><ChannelDetail label="Stored gain" value={selectedAssignment.gainDb == null ? "Not set" : `${selectedAssignment.gainDb} dB`} /><ChannelDetail label="Phantom power" value={selectedAssignment.phantom ? "48V enabled" : "Off"} /><ChannelDetail label="Assignment mute" value={selectedAssignment.muted ? "Muted" : "Open"} /><ChannelDetail label="Notes" value={selectedAssignment.notes || "No notes"} /></div>
            <div className="mt-6 grid gap-2"><button disabled={controlsDisabled} onClick={() => void handleToggleMute(selectedAssignment)} className={controlClass}>{selectedAssignment.muted ? "Mark unmuted" : "Mark muted"}</button><button disabled={controlsDisabled} onClick={() => openEditor(selectedAssignment)} className={controlClass}>Edit assignment</button><button disabled={controlsDisabled} onClick={() => void handleDelete(selectedAssignment)} className={`${controlClass} text-red-400`}>Delete channel</button></div>
            {enabledMixer && <Link to="/$slug/dashboard/devices/$deviceId" params={{ slug, deviceId: enabledMixer.id }} className={`${controlClass} mt-6 flex items-center justify-between gap-2`}><span>Open {enabledMixer.name} controls</span><ChevronRight className="h-4 w-4 shrink-0" /></Link>}
          </aside>}
        </div>}
    </div>
    {editor && <MicAssignmentForm key={editor.key} existing={editor.assignment} open={editor.open} locked={writeLocked} busy={busy} nextChannel={assignments.length ? Math.max(...assignments.map(row => row.channel)) + 1 : 1} onClose={() => void closeEditor()} onSave={saveDraft} onDirty={setFormDirty} notice={notice} />}
    <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open && blocker.status === "blocked") blocker.reset(); }}><DialogContent aria-modal="true" showCloseButton={false} className="border-board-border bg-board-card text-board-text"><DialogTitle>Leave Audio?</DialogTitle><DialogDescription>Unsaved drafts and retry controls will be discarded. An unconfirmed change may still complete; review this show when you return.</DialogDescription><div className="flex flex-wrap gap-2"><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.reset()}>Stay</button><button className={controlClass} onClick={() => blocker.status === "blocked" && blocker.proceed()}>Leave Audio</button></div></DialogContent></Dialog>
  </div>;
}
function AudioStat({ label, value, icon: Icon, tone = "text-board-text" }: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  tone?: string;
}) {
  return (
    <div className="flex min-h-[76px] items-center gap-3 px-4 py-3"><Icon className="h-4 w-4 text-board-muted" /><div><p className={`text-base font-semibold tabular-nums ${tone}`}>{value}</p><p className="mt-0.5 text-[10px] text-board-muted">{label}</p></div></div>
  );
}

function ChannelDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-board-border/60 pb-3 last:border-0"><p className="text-[10px] text-board-muted">{label}</p><p className="mt-1 break-words text-xs text-board-text">{value}</p></div>
  );
}

function MicAssignmentForm({ existing, open, locked, busy, nextChannel, onClose, onSave, onDirty, notice }: {
  existing: Assignment | null; open: boolean; locked: boolean; busy: boolean; nextChannel: number;
  onClose: () => void; onSave: (draft: AudioDraft) => void; onDirty: (dirty: boolean) => void; notice: React.ReactNode;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const [channel, setChannel] = useState(existing?.channel ?? nextChannel);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [micType, setMicType] = useState(existing?.micType ?? "wireless-handheld");
  const [micModel, setMicModel] = useState(existing?.micModel ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [gainDb, setGainDb] = useState<number | "">(existing?.gainDb ?? "");
  const [phantom, setPhantom] = useState(existing?.phantom ?? false);
  const [group, setGroup] = useState(existing?.group ?? "vocals");
  const [original] = useState(() => JSON.stringify({ channel, label, micType, micModel, notes, gainDb, phantom, group }));
  const dirty = JSON.stringify({ channel, label, micType, micModel, notes, gainDb, phantom, group }) !== original;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (locked || !label.trim()) return;
    onSave({ channel, label: label.trim(), micType, micModel: micModel.trim(), notes: notes.trim(), gainDb: gainDb === "" ? null : gainDb, phantom, group });
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><DialogContent aria-modal="true" showCloseButton={false} className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text">
    <div className="flex shrink-0 items-start gap-3 border-b border-board-border p-4"><div className="min-w-0 flex-1"><DialogTitle>{existing ? "Edit Channel" : "Add Channel"}</DialogTitle><DialogDescription className="mt-1">Save this show's patch notes. These fields do not operate a physical mixer.</DialogDescription></div><button disabled={busy} type="button" aria-label="Close channel editor" className={`${controlClass} min-w-11`} onClick={onClose}><X className="h-4 w-4" /></button></div>
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
      <div className="min-h-0 space-y-4 overflow-y-auto p-4">{notice}<fieldset disabled={locked} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="audio-channel" className="block text-sm text-board-muted mb-1.5">Channel #</label>
              <input id="audio-channel"
                type="number"
                min={1}
                value={channel}
                onChange={(e) => setChannel(Number(e.target.value))}
                className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="audio-group" className="block text-sm text-board-muted mb-1.5">Group</label>
              <select id="audio-group"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors appearance-none"
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
            <label htmlFor="audio-label" className="block text-sm text-board-muted mb-1.5">Label</label>
            <input id="audio-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={workspaceCopy(
                "e.g. Pastor James, Kick Drum, Keys L",
                workspaceTerms,
              )}
              className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="audio-mic-type" className="block text-sm text-board-muted mb-1.5">Mic Type</label>
              <select id="audio-mic-type"
                value={micType}
                onChange={(e) => setMicType(e.target.value)}
                className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text focus:outline-none focus:border-fire-500 transition-colors appearance-none"
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
              <label htmlFor="audio-mic-model" className="block text-sm text-board-muted mb-1.5">Mic / Model</label>
              <input id="audio-mic-model"
                type="text"
                value={micModel}
                onChange={(e) => setMicModel(e.target.value)}
                placeholder="e.g. Shure SM58"
                className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="audio-gain" className="block text-sm text-board-muted mb-1.5">Gain (dB)</label>
              <input id="audio-gain"
                type="number"
                value={gainDb}
                onChange={(e) =>
                  setGainDb(e.target.value ? Number(e.target.value) : "")
                }
                placeholder="-10"
                className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors tabular-nums"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex min-h-11 items-center gap-2.5 cursor-pointer">
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
            <label htmlFor="audio-notes" className="block text-sm text-board-muted mb-1.5">Notes</label>
            <textarea id="audio-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. needs new battery, pad -10dB"
              rows={2}
              className="min-h-11 min-w-0 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors resize-none"
            />
          </div>

      </fieldset></div>
      <div className="flex shrink-0 gap-3 border-t border-board-border p-4"><button type="button" disabled={busy} className={`${controlClass} flex-1`} onClick={onClose}>Cancel</button><button type="submit" disabled={locked || !label.trim()} className={`${controlClass} flex-1 bg-fire-500 text-black`}>{busy ? "Saving…" : existing ? "Update" : "Add Channel"}</button></div>
    </form>
  </DialogContent></Dialog>;
}
