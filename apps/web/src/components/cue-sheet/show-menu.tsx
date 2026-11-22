import { useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import type { ShowSwitcherOption } from "@/components/show-switcher-menu";

export function CueShowMenu({ shows, selectedId, today, onSelect }: { shows: ShowSwitcherOption[]; selectedId: string | null; today: string; onSelect: (show: ShowSwitcherOption) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const selected = shows.find(show => show.id === selectedId);
  const formatDate = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const filtered = useMemo(() => shows.filter(show => `${show.name || "Untitled show"} ${show.serviceDate} ${formatDate(show.serviceDate)}`.toLowerCase().includes(query.trim().toLowerCase())), [shows, query]);
  const groups = [{ label: "Upcoming", shows: filtered.filter(show => show.serviceDate >= today).sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)) }, { label: "Past", shows: filtered.filter(show => show.serviceDate < today).sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)) }];
  const options = groups.flatMap(group => group.shows);
  const pick = (show: ShowSwitcherOption) => { onSelect(show); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setActive(0); } }}><Popover.Trigger asChild>
    <button type="button" className="cue-button max-w-full min-h-9" aria-label="Choose show" disabled={!shows.length}>
      <CalendarDays className="opacity-60" /><span className="truncate font-semibold">{selected?.name || (selected ? "Untitled show" : "Choose show")}</span>
      {selected && <span className="cue-quiet cue-mono hidden sm:inline">{formatDate(selected.serviceDate)}</span>}<ChevronDown className="opacity-60" />
    </button>
  </Popover.Trigger><Popover.Portal><Popover.Content align="start" sideOffset={4} className="cue-portal cue-columns-pop z-40 w-[360px]" onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}>
    <div className="m-2 flex items-center gap-2 rounded-md border border-board-border px-2"><Search className="h-3.5 w-3.5 text-board-muted" /><input ref={search} aria-label="Search shows" role="combobox" aria-expanded="true" aria-controls="cue-show-options" aria-activedescendant={options[active] ? `cue-show-${options[active].id}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(previous => Math.max(0, Math.min(options.length - 1, previous + (event.key === "ArrowDown" ? 1 : -1)))); } else if (event.key === "Enter" && options[active]) { event.preventDefault(); pick(options[active]); } }}
      placeholder="Search shows" className="min-h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none" /><kbd className="cue-quiet rounded border border-board-border px-1">/</kbd></div>
    <div role="listbox" id="cue-show-options" aria-label="Shows" className="max-h-[min(520px,60dvh)] overflow-y-auto">
      {groups.filter(group => group.shows.length > 0).map(group => <div key={group.label} role="group" aria-label={group.label} className="border-b border-board-border p-2 last:border-b-0"><p className="cue-pop-label px-2 pb-2 pt-2">{group.label}</p>
        {group.shows.map(show => <button type="button" role="option" aria-selected={show.id === selectedId} id={`cue-show-${show.id}`} key={show.id} onClick={() => pick(show)} onMouseEnter={() => setActive(options.indexOf(show))}
          className={`flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left ${options[active]?.id === show.id ? "bg-board-border/60" : ""}`}>
          <span className="w-3.5 shrink-0">{show.id === selectedId && <Check className="h-3.5 w-3.5 text-fire-500" />}</span><span className="min-w-0"><span className="block truncate text-[13px] font-medium">{show.name || "Untitled show"}</span><span className="cue-quiet cue-mono block text-[11px]">{formatDate(show.serviceDate)}</span></span>
        </button>)}
      </div>)}
      {!options.length && <p className="cue-quiet px-4 py-6">No shows match your search.</p>}
    </div><div className="cue-quiet flex justify-between gap-3 border-t border-board-border px-4 py-2"><span>↑↓ to move · Enter to open</span><span>Untitled = no show name set</span></div>
  </Popover.Content></Popover.Portal></Popover.Root>;
}
