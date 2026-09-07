import { CalendarDays, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { formatServicePickerLabel } from "@/lib/service-picker";

export interface RundownShowOption {
  id: string;
  serviceDate: string;
  name: string;
  scheduledStartTime?: string | null;
}

export function ShowOptionsModal({
  busy,
  canCreate,
  canEdit,
  onClose,
  onCreate,
  onDateChange,
  onNameChange,
  onSelectShow,
  onShiftDate,
  onStartTimeChange,
  onToday,
  selectedDate,
  selectedShowId,
  serviceName,
  shows,
  startTime,
  timeZone,
}: {
  busy: boolean;
  canCreate: boolean;
  canEdit: boolean;
  onClose: () => void;
  onCreate: () => void;
  onDateChange: (date: string) => void;
  onNameChange: (name: string) => void;
  onSelectShow: (show: RundownShowOption) => void;
  onShiftDate: (days: number) => void;
  onStartTimeChange: (time: string) => void;
  onToday: () => void;
  selectedDate: string;
  selectedShowId?: string | null;
  serviceName: string;
  shows: RundownShowOption[];
  startTime: string;
  timeZone?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="show-options-title" className="w-full max-w-md overflow-hidden rounded-2xl border border-board-border bg-board-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-board-border px-5 py-4">
          <div>
            <h2 id="show-options-title" className="text-base font-semibold text-board-text">Show options</h2>
            <p className="mt-1 text-xs text-board-muted">Switch shows or change this show's details.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close show options" className="rounded-lg p-2 text-board-muted transition-colors hover:bg-board-border/60 hover:text-board-text disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(70vh,38rem)] space-y-5 overflow-y-auto p-5">
          <section className="space-y-2">
            <label htmlFor="rundown-show-picker" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted">Show</label>
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-board-muted" />
              <select
                id="rundown-show-picker"
                value={selectedShowId ?? ""}
                onChange={(event) => {
                  const selected = shows.find((show) => show.id === event.target.value);
                  if (selected) onSelectShow(selected);
                }}
                disabled={busy}
                className="w-full appearance-none rounded-xl border border-board-border bg-board-bg py-2.5 pl-10 pr-4 text-sm text-board-text outline-none transition-colors focus:border-fire-500/50"
              >
                {!selectedShowId ? <option value="">No planned show</option> : null}
                {shows.map((show) => <option key={show.id} value={show.id}>{formatServicePickerLabel(show, { timeZone })}</option>)}
              </select>
            </div>
          </section>

          <section className="space-y-2">
            <label htmlFor="rundown-show-date" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted">Date</label>
            <input
              id="rundown-show-date"
              type="date"
              value={selectedDate}
              onChange={(event) => event.target.value && onDateChange(event.target.value)}
              disabled={busy}
              className="w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none transition-colors focus:border-fire-500/50"
            />
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => onShiftDate(-1)} disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-board-border text-xs font-medium text-board-muted hover:text-board-text disabled:opacity-50"><ChevronLeft className="h-4 w-4" />Previous</button>
              <button type="button" onClick={onToday} disabled={busy} className="min-h-10 rounded-lg border border-board-border text-xs font-medium text-board-text hover:bg-board-border/40 disabled:opacity-50">Today</button>
              <button type="button" onClick={() => onShiftDate(1)} disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-board-border text-xs font-medium text-board-muted hover:text-board-text disabled:opacity-50">Next<ChevronRight className="h-4 w-4" /></button>
            </div>
          </section>

          {canEdit ? <section className="grid gap-3 border-t border-board-border pt-5 sm:grid-cols-[1fr_8.5rem]">
            <label className="space-y-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted">
              <span>Show name</span>
              <input type="text" value={serviceName} onChange={(event) => onNameChange(event.target.value)} maxLength={120} placeholder="Name this show" className="w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-board-text outline-none focus:border-fire-500/50" />
            </label>
            <label className="space-y-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted">
              <span>Start time</span>
              <input type="time" value={startTime} onChange={(event) => onStartTimeChange(event.target.value)} className="w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm font-normal normal-case tracking-normal text-board-text outline-none focus:border-fire-500/50" />
            </label>
          </section> : null}

          {busy ? <p className="text-xs text-board-muted" role="status">Saving changes…</p> : null}
          {canCreate ? <button type="button" onClick={onCreate} disabled={busy} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-semibold text-black transition-colors hover:bg-fire-400 disabled:opacity-50"><Plus className="h-4 w-4" />Create another show</button> : null}
        </div>
      </div>
    </div>
  );
}
