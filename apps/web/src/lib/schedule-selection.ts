import { idSchema, serviceDateSchema } from "@/lib/validation";

export interface ScheduleSearch {
  show?: string;
  date?: string;
  assignment?: string;
  month?: string;
}

export function normalizeScheduleSearch(
  search: Record<string, unknown>,
): ScheduleSearch {
  const date = serviceDateSchema.safeParse(search.date);
  const show = idSchema.safeParse(search.show);
  const assignment = idSchema.safeParse(search.assignment);
  const month = serviceDateSchema.safeParse(
    typeof search.month === "string" ? `${search.month}-01` : undefined,
  );
  return {
    show: show.success ? show.data : undefined,
    date: date.success ? date.data : undefined,
    assignment: assignment.success ? assignment.data : undefined,
    month: month.success ? month.data.slice(0, 7) : undefined,
  };
}

export function getScheduleSelectionDeps(search: ScheduleSearch) {
  return {
    selectedDate: search.date,
    selectedShowId: search.show,
    calendarMonth: search.month,
  };
}

/** The caller supplies a month already validated at the search/input boundary. */
export function getScheduleMonthWindow(month: string) {
  const end = new Date(`${month}-01T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { from: `${month}-01`, to: end.toISOString().slice(0, 10) };
}

export function buildScheduleQuerySelection(input: {
  from: string;
  to: string;
  selectedDate?: string;
  selectedShowId?: string;
}) {
  const dateRange = { gte: input.from, lte: input.to };
  return {
    rundowns: [
      { serviceDate: dateRange },
      ...(input.selectedDate ? [{ serviceDate: input.selectedDate }] : []),
      ...(input.selectedShowId ? [{ id: input.selectedShowId }] : []),
    ],
    related: [
      { serviceDate: dateRange },
      ...(input.selectedDate ? [{ serviceDate: input.selectedDate }] : []),
      ...(input.selectedShowId ? [{ showId: input.selectedShowId }] : []),
    ],
  };
}
