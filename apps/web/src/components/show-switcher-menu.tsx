import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { formatServicePickerLabel } from "@/lib/service-picker";
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
}: {
  disabled?: boolean;
  onSelect: (show: ShowSwitcherOption) => void;
  selectedId: string | null | undefined;
  shows: ShowSwitcherOption[];
  timeZone?: string;
}) {
  const selected = shows.find((show) => show.id === selectedId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled || shows.length === 0}
          className="inline-flex min-h-9 max-w-[min(19rem,48vw)] items-center gap-2 rounded-lg border border-board-border bg-board-card px-3 text-xs font-medium text-board-text transition-colors hover:border-fire-500/40 disabled:opacity-45"
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
        <DropdownMenuLabel className="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-board-muted">
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
                <span className="mt-0.5 block truncate text-[10px] text-board-muted">
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
