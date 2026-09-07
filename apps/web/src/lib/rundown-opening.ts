export interface RundownOpeningCandidate {
  id: string;
  serviceDate: string;
}

/** Select a default show, while preserving an explicitly requested empty date. */
export function resolveRundownOpeningShow<T extends RundownOpeningCandidate>(input: {
  shows: T[];
  today: string;
  requestedShowId?: string;
  requestedServiceDate?: string;
  activeShowId?: string;
  activeServiceDate?: string;
}): T | undefined {
  const { shows } = input;
  const activeShow = input.activeShowId
    ? shows.find((show) => show.id === input.activeShowId)
    : undefined;
  if (input.requestedShowId || input.requestedServiceDate) {
    return (input.requestedShowId ? shows.find((show) => show.id === input.requestedShowId) : undefined) ??
      (input.requestedServiceDate && activeShow?.serviceDate === input.requestedServiceDate ? activeShow : undefined) ??
      (input.requestedServiceDate ? shows.find((show) => show.serviceDate === input.requestedServiceDate) : undefined);
  }
  return activeShow ??
    (input.activeServiceDate ? shows.find((show) => show.serviceDate === input.activeServiceDate) : undefined) ??
    shows.find((show) => show.serviceDate >= input.today) ??
    shows.at(-1);
}

/**
 * Split an already chronological show list around one exact show instance.
 * Same-day shows remain separate because the stable show ID, not the calendar
 * date, defines the boundary.
 */
export function partitionShowsAround<T extends RundownOpeningCandidate>(
  shows: T[],
  selectedShowId: string,
): { previous: T[]; upcoming: T[] } {
  const selectedIndex = shows.findIndex((show) => show.id === selectedShowId);
  if (selectedIndex < 0) return { previous: [], upcoming: [] };
  return {
    previous: shows.slice(0, selectedIndex).reverse(),
    upcoming: shows.slice(selectedIndex + 1),
  };
}
