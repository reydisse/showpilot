import { useId, useState, type InputHTMLAttributes } from "react";
import { Popover } from "radix-ui";
import { CalendarDays, Clock } from "lucide-react";

// A shared field, including free text for exact minutes and keyboard-only entry.
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  kind: "date" | "time";
  onValueChange: (value: string) => void;
};
const focus = "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";
export function DateTimePicker({ kind, onValueChange, className, ...props }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const value = kind === "date" && props.value ? new Date(`${props.value}T12:00:00`) : new Date();
    return Number.isNaN(value.getTime()) ? new Date() : value;
  });
  const year = month.getFullYear(), index = month.getMonth();
  const choose = (value: string) => { onValueChange(value); setOpen(false); };
  const Icon = kind === "date" ? CalendarDays : Clock;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <div className="relative min-w-0">
      <input {...props} id={props.id ?? id} type="text" inputMode="text"
        placeholder={props.placeholder ?? (kind === "date" ? "YYYY-MM-DD" : "HH:MM")}
        pattern={kind === "date" ? "[0-9]{4}-[0-9]{2}-[0-9]{2}" : "([01][0-9]|2[0-3]):[0-5][0-9]"}
        onChange={event => onValueChange(event.target.value)}
        className={`min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm tabular-nums text-board-text ${focus} ${className ?? ""} !pr-11`} />
      <Popover.Trigger asChild><button type="button" disabled={props.disabled} aria-label={`Choose ${props["aria-label"] ?? kind}`} className={`absolute right-1 top-1/2 -translate-y-1/2 p-2 text-board-muted ${focus}`}><Icon size={16} /></button></Popover.Trigger>
    </div>
    <Popover.Portal><Popover.Content sideOffset={4} align="start" className="z-[100] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-board-border bg-board-card p-3 text-sm text-board-text shadow-lg" onClick={event => event.stopPropagation()}>
      {kind === "date" ? <>
        <div className="mb-3 flex items-center justify-between">
          <button type="button" aria-label="Previous month" className={`px-3 py-1 ${focus}`} onClick={() => setMonth(new Date(year, index - 1, 1))}>‹</button>
          <span aria-live="polite">{month.toLocaleDateString("en-CA", { month: "long", year: "numeric" })}</span>
          <button type="button" aria-label="Next month" className={`px-3 py-1 ${focus}`} onClick={() => setMonth(new Date(year, index + 1, 1))}>›</button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(day => <span key={day} className="text-xs text-board-muted">{day}</span>)}
          {Array.from({ length: new Date(year, index, 1).getDay() }, (_, i) => <span key={`blank-${i}`} />)}
          {Array.from({ length: new Date(year, index + 1, 0).getDate() }, (_, i) => {
            const value = `${year}-${String(index + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
            return <button type="button" key={value} aria-label={value} aria-pressed={props.value === value} disabled={(!!props.min && value < String(props.min)) || (!!props.max && value > String(props.max))} onClick={() => choose(value)} className={`py-2 hover:bg-fire-500/10 aria-pressed:bg-fire-500/10 ${focus}`}>{i + 1}</button>;
          })}
        </div>
      </> : <div aria-label="Time options" className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
        {Array.from({ length: 96 }, (_, i) => {
          const value = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String(i % 4 * 15).padStart(2, "0")}`;
          return <button type="button" key={value} aria-pressed={props.value === value} onClick={() => choose(value)} className={`py-2 tabular-nums hover:bg-fire-500/10 aria-pressed:bg-fire-500/10 ${focus}`}>{value}</button>;
        })}
      </div>}
      <div className="mt-2 flex justify-between">
        {!props.required && <button type="button" className={`px-2 py-1 text-board-muted ${focus}`} onClick={() => choose("")}>Clear</button>}
        <Popover.Close className={`px-2 py-1 text-board-muted ${focus}`}>Close</Popover.Close>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
