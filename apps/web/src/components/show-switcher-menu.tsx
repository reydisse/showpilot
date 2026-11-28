import { useState } from "react";
import { CalendarDays, Check, ChevronDown, Search } from "lucide-react";
import { formatServiceDate, formatServicePickerLabel } from "@/lib/service-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ShowSwitcherOption {
  id: string;
  serviceDate: string;
  name: string;
  scheduledStartTime?: string | null;
}

export function ShowSwitcherMenu({
  disabled,
  onSelect,
  selectedId,
  shows,
  timeZone,
  variant = "default",
  today,
}: {
  /** "a" is the Doop design-A menu: search, Upcoming and Past groups. */
  variant?: "default" | "a";
  /** YYYY-MM-DD used to split upcoming from past in the "a" variant. */
  today?: string;
  disabled?: boolean;
  onSelect: (show: ShowSwitcherOption) => void;
  selectedId: string | null | undefined;
  shows: ShowSwitcherOption[];
  timeZone?: string;
}) {
  const selected = shows.find((show) => show.id === selectedId) ?? null;
  if (variant === "a") return <ShowSwitcherMenuA disabled={disabled} onSelect={onSelect} selected={selected} shows={shows} today={today} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || shows.length === 0}
          className="inline-flex min-h-11 max-w-[min(19rem,48vw)] items-center gap-2 rounded-lg border border-board-border bg-board-card px-3 text-xs font-medium text-board-text transition-colors hover:border-fire-500/40 disabled:opacity-45"
          aria-label="Choose show"
        >
          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-board-muted" />
          <span className="truncate">
            {selected ? formatServicePickerLabel(selected, { timeZone }) : "Choose show"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-board-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-[min(22rem,calc(100vw-2rem))] p-1.5">
        <DropdownMenuLabel className="px-2 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-board-muted">
          Switch show
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {shows.map((show) => {
          const active = show.id === selectedId;
          return (
            <DropdownMenuItem
              key={show.id}
              onSelect={() => onSelect(show)}
              className="min-h-11 items-center gap-3 px-2.5 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-board-text">
                  {show.name || "Untitled show"}
                </span>
                <span className="mt-0.5 block truncate text-xs text-board-muted">
                  {formatServicePickerLabel({ ...show, name: "" }, { timeZone })}
                </span>
              </span>
              {active ? <Check className="h-4 w-4 text-fire-400" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShowSwitcherMenuA({ disabled, onSelect, selected, shows, today }: {
  disabled?: boolean;
  onSelect: (show: ShowSwitcherOption) => void;
  selected: ShowSwitcherOption | null;
  shows: ShowSwitcherOption[];
  today?: string;
}) {
  const [query, setQuery] = useState("");
  const day = today ?? new Date().toISOString().slice(0, 10);
  const needle = query.trim().toLowerCase();
  const matches = shows.filter((show) => !needle || `${show.name} ${formatServiceDate(show.serviceDate)}`.toLowerCase().includes(needle));
  const groups = [
    { label: "Upcoming", items: matches.filter((show) => show.serviceDate >= day).sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)) },
    { label: "Past", items: matches.filter((show) => show.serviceDate < day).sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)) },
  ].filter((group) => group.items.length);
  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setQuery(""); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || shows.length === 0}
          aria-label="Choose show"
          className="inline-flex h-9 max-w-[min(22rem,60vw)] items-center gap-2 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 text-[13px] text-board-text hover:bg-[var(--sa-surface-2)] disabled:opacity-45 data-[state=open]:border-board-text/60 max-lg:h-11"
        >
          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
          <span className="truncate font-semibold">{selected ? selected.name || "Untitled show" : "Choose show"}</span>
          {selected ? <span className="shrink-0 tabular-nums text-[var(--sa-ink-2)] max-sm:hidden">{formatServiceDate(selected.serviceDate)}</span> : null}
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="schedule-a flex max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0">
        <div className="border-b border-[var(--sa-border)] p-2">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--sa-border-strong)] bg-board-bg px-2.5">
            <Search aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation(); }}
              aria-label="Search shows"
              placeholder="Search shows"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-board-text outline-none placeholder:text-[var(--sa-ink-3)]"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.length === 0 ? <p className="px-2.5 py-3 text-[13px] text-[var(--sa-ink-3)]">No shows match.</p> : null}
          {groups.map((group, index) => (
            <div key={group.label} className={index ? "mt-1 border-t border-[var(--sa-border)] pt-1" : ""}>
              <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--sa-ink-3)]">{group.label}</DropdownMenuLabel>
              {group.items.map((show) => {
                const active = show.id === selected?.id;
                return (
                  <DropdownMenuItem key={show.id} onSelect={() => onSelect(show)} className="min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-1.5">
                    <span className="flex w-4 shrink-0 justify-center">{active ? <Check aria-hidden="true" className="h-4 w-4 text-fire-400" /> : null}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-board-text">{show.name || "Untitled show"}</span>
                      <span className="block truncate text-xs tabular-nums text-[var(--sa-ink-3)]">{formatServiceDate(show.serviceDate)}</span>
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--sa-border)] px-3 py-2 text-xs text-[var(--sa-ink-3)]">
          <span>↑↓ to move · Enter to open</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
