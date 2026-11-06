import { useEffect, useRef, useState } from "react";
import { Calendar, FileText, FolderOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeleteSavedTemplateButton } from "./DeleteSavedTemplateButton";
import { listRundownDates, listSavedRundowns, getRundownState, loadSavedRundown, deleteSavedRundown } from "@/lib/rundown";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { formatTimeInput } from "@/lib/utils";
import type { RundownItem } from "@/types/rundown";

type LoadedRundown = { items: RundownItem[]; serviceName?: string; scheduledStartTime?: string };
type Selection = { kind: "date"; date: string; showId: string } | { kind: "saved"; id: string };
type ListState = { kind: "loading" } | { kind: "error"; occurredAt: number } | {
  kind: "ready"; dates: Awaited<ReturnType<typeof listRundownDates>>; saved: Awaited<ReturnType<typeof listSavedRundowns>>;
};
type Operation = { kind: "idle" } | { kind: "reading" | "applying"; selection: Selection }
  | { kind: "review"; selection: Selection; loaded: LoadedRundown; revision: number }
  | { kind: "error"; selection: Selection; message: string; occurredAt: number; canRetry: boolean };
interface Props {
  orgId: string;
  timeZone?: string;
  currentItemCount: number;
  playing: boolean;
  revision: number;
  onLoad: (loaded: LoadedRundown) => void | Promise<void>;
  onClose: () => void;
}
const READ_TIMEOUT_MS = 10_000;

export function LoadRundownModal(props: Props) {
  // A workspace change cancels all response ownership, even if callers reuse the dialog.
  return <LoadRundownSession key={props.orgId} {...props} />;
}

function LoadRundownSession({ orgId, timeZone, currentItemCount, playing, revision, onLoad, onClose }: Props) {
  const [tab, setTab] = useState<"dates" | "saved">("dates");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const [refresh, setRefresh] = useState(0);
  const attempt = useRef(0);
  const alive = useRef(false);
  const latest = useRef({ onLoad, currentItemCount, playing, revision });
  latest.current = { onLoad, currentItemCount, playing, revision };
  const busy = operation.kind === "reading" || operation.kind === "applying" || operation.kind === "review";

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; attempt.current++; };
  }, []);

  useEffect(() => {
    let current = true;
    setList({ kind: "loading" });
    void withOperationTimeout(Promise.all([
      listRundownDates({ data: { orgId } }), listSavedRundowns({ data: { orgId } }),
    ]), READ_TIMEOUT_MS, "Rundown list request timed out").then(([dates, saved]) => {
      if (current) setList({ kind: "ready", dates, saved });
    }).catch(() => {
      if (current) setList({ kind: "error", occurredAt: Date.now() });
    });
    return () => { current = false; };
  }, [orgId, refresh]);

  async function apply(selection: Selection, loaded: LoadedRundown) {
    const request = ++attempt.current;
    setOperation({ kind: "applying", selection });
    try {
      await withOperationTimeout(Promise.resolve().then(() => { if (alive.current && request === attempt.current) return latest.current.onLoad(loaded); }), READ_TIMEOUT_MS, "Rundown application was not confirmed");
      if (alive.current && request === attempt.current) setOperation({ kind: "idle" });
    } catch {
      if (alive.current && request === attempt.current) setOperation({ kind: "error", selection, canRetry: false, occurredAt: Date.now(),
        message: "Could not confirm that the rundown was replaced. Close this dialog and review the current rundown before trying again." });
    }
  }

  async function load(selection: Selection) {
    const request = ++attempt.current;
    setOperation({ kind: "reading", selection });
    try {
      let loaded: LoadedRundown;
      if (selection.kind === "date") {
        const state = await withOperationTimeout(getRundownState({ data: { orgId, serviceDate: selection.date, showId: selection.showId } }), READ_TIMEOUT_MS, "Rundown request timed out");
        loaded = { items: state.items, serviceName: state.meta?.name ?? "", scheduledStartTime: formatTimeInput(state.meta?.scheduledStartTime, timeZone) };
      } else {
        const saved = await withOperationTimeout(loadSavedRundown({ data: { orgId, rundownId: selection.id } }), READ_TIMEOUT_MS, "Template request timed out");
        if (!saved) throw new Error("Template no longer exists");
        loaded = saved;
      }
      if (!alive.current || request !== attempt.current) return;
      if (latest.current.currentItemCount > 0 || latest.current.playing) {
        setOperation({ kind: "review", selection, loaded, revision: latest.current.revision });
      } else await apply(selection, loaded);
    } catch {
      if (alive.current && request === attempt.current) setOperation({ kind: "error", selection, canRetry: true, occurredAt: Date.now(),
        message: "Could not read the selected rundown. Check your connection and retry, or refresh the list if it was removed." });
    }
  }

  async function removeSaved(id: string) {
    await deleteSavedRundown({ data: { orgId, rundownId: id } });
    if (alive.current) setList(previous => previous.kind === "ready" ? { ...previous, saved: previous.saved.filter(item => item.id !== id) } : previous);
  }
  const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const errorTime = (occurredAt: number) => <time dateTime={new Date(occurredAt).toISOString()} className="whitespace-nowrap">{new Date(occurredAt).toLocaleTimeString()}</time>;
  const reviewChanged = operation.kind === "review" && operation.revision !== revision;

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={false} className="rundown-modal block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border-board-border bg-board-card p-0 sm:max-w-lg">
      <div className="flex items-center justify-between px-6 pb-3 pt-5">
        <DialogTitle className="text-lg font-semibold text-board-text">Load Rundown</DialogTitle>
        <Button variant="ghost" type="button" onClick={onClose} aria-label="Close load rundown" className="min-h-11 min-w-11"><X className="h-4 w-4" /></Button>
      </div>
      <div className="mb-3 flex flex-wrap gap-2 px-6">
        <Button variant="outline" onClick={() => setTab("dates")} aria-pressed={tab === "dates"}><Calendar />Previous Dates</Button>
        <Button variant="outline" onClick={() => setTab("saved")} aria-pressed={tab === "saved"}><FileText />Saved Templates</Button>
        <Button variant="ghost" disabled={busy || list.kind === "loading" || (operation.kind === "error" && !operation.canRetry)} onClick={() => { setOperation({ kind: "idle" }); setRefresh(value => value + 1); }}>Refresh list</Button>
      </div>
      <div className="space-y-3 px-6 pb-5">
        {operation.kind === "error" && <div role="alert" className="space-y-2 rounded-xl border border-red-400/40 p-3 text-sm text-red-300">
          <p>{operation.message} {errorTime(operation.occurredAt)}</p>
          {operation.canRetry ? <Button variant="outline" onClick={() => void load(operation.selection)}>Retry load</Button> : <Button variant="outline" onClick={onClose}>Review current rundown</Button>}
        </div>}
        {operation.kind === "reading" && <p role="status" className="text-sm text-board-muted">Reading rundown…</p>}
        {operation.kind === "applying" && <p role="status" className="text-sm text-board-muted">Applying rundown…</p>}
        {list.kind === "loading" ? <p role="status" className="py-8 text-sm text-board-muted">Loading rundowns…</p> : list.kind === "error" ? <div role="alert" className="space-y-2 rounded-xl border border-red-400/40 p-3 text-sm text-red-300">
          <p>Could not load rundowns. Check your connection and retry. {errorTime(list.occurredAt)}</p>
          <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Retry list</Button>
        </div> : tab === "dates" ? list.dates.length === 0 ? <p className="py-8 text-sm text-board-muted">No previous rundowns found</p> : list.dates.map(date => <Button key={date.showId} variant="ghost" disabled={busy || (operation.kind === "error" && !operation.canRetry)}
          onClick={() => void load({ kind: "date", date: date.date, showId: date.showId })} className="h-auto w-full justify-between gap-3 whitespace-normal rounded-lg border border-board-border px-4 py-3 text-left">
          <span className="min-w-0"><span className="block break-words text-sm font-medium">{date.name || dateLabel(date.date)}</span><span className="block text-xs text-board-muted">{dateLabel(date.date)}{date.scheduledStartTime ? ` · ${formatTimeInput(date.scheduledStartTime, timeZone)}` : ""} · {date.itemCount} items</span></span><FolderOpen className="shrink-0" />
        </Button>) : list.saved.length === 0 ? <p className="py-8 text-sm text-board-muted">No saved templates yet. Use Save as template to create one.</p> : list.saved.map(saved => <div key={saved.id} className="flex items-center gap-2 rounded-lg border border-board-border px-4 py-3">
          <Button variant="ghost" disabled={busy || (operation.kind === "error" && !operation.canRetry)} onClick={() => void load({ kind: "saved", id: saved.id })} className="h-auto min-w-0 flex-1 justify-start whitespace-normal text-left">
            <span className="min-w-0"><span className="block break-words text-sm font-medium">{saved.name}</span><span className="block text-xs text-board-muted">{saved.itemCount} items{saved.serviceName ? ` · ${saved.serviceName}` : ""} · saved {new Date(saved.createdAt).toLocaleDateString()}</span></span>
          </Button><DeleteSavedTemplateButton name={saved.name} disabled={busy || (operation.kind === "error" && !operation.canRetry)} onDelete={() => removeSaved(saved.id)} />
        </div>)}
      </div>
      <ConfirmDialog open={operation.kind === "review"} onOpenChange={open => { if (!open) setOperation({ kind: "idle" }); }} title="Replace the current rundown?"
        description={playing ? "Pause or stop the timer before replacing the rundown." : reviewChanged ? "The rundown changed while this confirmation was open. Cancel and select it again to review the current state." : "This replaces all current items and resets the timer for every connected operator. The source rundown or template is kept."}
        confirmLabel="Replace rundown" confirmDisabled={playing || reviewChanged} onConfirm={() => { if (operation.kind === "review" && !playing && !reviewChanged) void apply(operation.selection, operation.loaded); }} />
    </DialogContent>
  </Dialog>;
}
