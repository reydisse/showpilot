import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { ModalA, modalCancel, modalPrimary } from "@/components/schedule/modal-a";
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
  onCallTimeChange,
  onNameChange,
  onSelectShow,
  onShiftDate,
  onStartTimeChange,
  onToday,
  selectedDate,
  selectedShowId,
  serviceName,
  callTime,
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
  onCallTimeChange: (time: string) => void;
  onNameChange: (name: string) => void;
  onSelectShow: (show: RundownShowOption) => void;
  onShiftDate: (days: number) => void;
  onStartTimeChange: (time: string) => void;
  onToday: () => void;
  selectedDate: string;
  selectedShowId?: string | null;
  serviceName: string;
  callTime: string;
  shows: RundownShowOption[];
  startTime: string;
  timeZone?: string;
}) {
  // Name and times are a draft until Save changes; picking another show or date opens it at once.
  const [draft, setDraft] = useState({ name: serviceName, start: startTime, call: callTime });
  useEffect(() => { setDraft({ name: serviceName, start: startTime, call: callTime }); }, [selectedShowId, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = draft.name !== serviceName || draft.start !== startTime || draft.call !== callTime;
  const save = () => {
    if (draft.name !== serviceName) onNameChange(draft.name);
    if (draft.start !== startTime) onStartTimeChange(draft.start);
    if (draft.call !== callTime) onCallTimeChange(draft.call);
    onClose();
  };
  const field = "h-10 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 disabled:opacity-60 sm:text-[13px] max-lg:h-11";
  const label = "mb-1.5 block text-[13px] font-medium text-board-text";
  const step = "inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-50 max-lg:h-11";
  return (
    <ModalA className="rundown-modal sm:max-w-[560px]" title="Show options" description="Switch shows or change this show's details." closeLabel="Close show options" onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); save(); }} className="flex flex-col gap-5">
        <div>
          <label htmlFor="rundown-show-picker" className={label}>Show</label>
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
            <select id="rundown-show-picker" value={selectedShowId ?? ""} disabled={busy}
              onChange={(event) => { const selected = shows.find((show) => show.id === event.target.value); if (selected) onSelectShow(selected); }}
              className={`${field} appearance-none pl-9 pr-9`}>
              {!selectedShowId ? <option value="">No planned show</option> : null}
              {shows.map((show) => <option key={show.id} value={show.id}>{formatServicePickerLabel(show, { timeZone })}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
          </div>
        </div>
        <div>
          <label htmlFor="rundown-show-date" className={label}>Date</label>
          <div className="flex flex-wrap gap-2">
            <input id="rundown-show-date" type="date" value={selectedDate} disabled={busy} onChange={(event) => event.target.value && onDateChange(event.target.value)} className={`${field} min-w-[160px] flex-1 tabular-nums`} />
            <div className="flex gap-1.5">
              <button type="button" onClick={() => onShiftDate(-1)} disabled={busy} className={step}><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
              <button type="button" onClick={onToday} disabled={busy} className={step}>Today</button>
              <button type="button" onClick={() => onShiftDate(1)} disabled={busy} className={step}><ChevronRight className="h-3.5 w-3.5" />Next</button>
            </div>
          </div>
        </div>
        {canEdit ? <div className="grid gap-4 border-t border-[var(--sa-border)] pt-5 sm:grid-cols-2">
          <div>
            <label htmlFor="rundown-show-name" className={label}>Show name</label>
            <input id="rundown-show-name" type="text" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={120} placeholder="Name this show" className={field} />
          </div>
          <div>
            <label htmlFor="rundown-show-start" className={label}>Start time <span className="font-normal text-[var(--sa-ink-3)]">· {timeZone || "UTC"}</span></label>
            <input id="rundown-show-start" type="time" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} className={`${field} tabular-nums`} />
          </div>
          <div>
            <label htmlFor="rundown-show-call" className={label}>Crew call <span className="font-normal text-[var(--sa-ink-3)]">· {timeZone || "UTC"}</span></label>
            <input id="rundown-show-call" type="time" value={draft.call} onChange={(event) => setDraft({ ...draft, call: event.target.value })} className={`${field} tabular-nums`} />
            <p className="mt-1.5 text-xs text-[var(--sa-ink-3)]">Leave blank to use the organization default.</p>
          </div>
        </div> : null}
        {busy ? <p role="status" className="text-xs text-[var(--sa-ink-3)]"><QuietActivity label="Saving changes…" /></p> : null}
        <div className="-mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
          {canCreate ? <button type="button" onClick={onCreate} disabled={busy} className="mr-auto inline-flex h-9 items-center gap-2 rounded-lg px-2 text-[13px] font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-50 max-lg:h-11"><Plus className="h-3.5 w-3.5" />Create another show</button> : <span className="mr-auto" />}
          <button type="button" onClick={onClose} disabled={busy} className={`${modalCancel} max-lg:h-11`}>Cancel</button>
          {canEdit ? <button type="submit" disabled={busy || !changed} className={`${modalPrimary} max-lg:h-11`}>Save changes</button> : null}
        </div>
      </form>
    </ModalA>
  );
}
