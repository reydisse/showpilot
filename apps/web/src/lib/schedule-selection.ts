import { idSchema, serviceDateSchema } from "@/lib/validation";

export interface ScheduleSearch {
  show?: string;
  date?: string;
  assignment?: string;
}

export function normalizeScheduleSearch(
  search: Record<string, unknown>,
): ScheduleSearch {
  const date = serviceDateSchema.safeParse(search.date);
  const show = idSchema.safeParse(search.show);
  const assignment = idSchema.safeParse(search.assignment);
  return {
    show: show.success ? show.data : undefined,
    date: date.success ? date.data : undefined,
    assignment: assignment.success ? assignment.data : undefined,
  };
}

export function getScheduleSelectionDeps(search: ScheduleSearch) {
  return {
    selectedDate: search.date,
    selectedShowId: search.show,
  };
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
