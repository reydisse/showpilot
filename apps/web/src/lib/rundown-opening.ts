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
  if (input.requestedShowId || input.requestedServiceDate) {
    return (input.requestedShowId ? shows.find((show) => show.id === input.requestedShowId) : undefined) ??
      (input.requestedServiceDate ? shows.find((show) => show.serviceDate === input.requestedServiceDate) : undefined);
  }
  return (input.activeShowId ? shows.find((show) => show.id === input.activeShowId) : undefined) ??
    (input.activeServiceDate ? shows.find((show) => show.serviceDate === input.activeServiceDate) : undefined) ??
    shows.find((show) => show.serviceDate >= input.today) ??
    shows.at(-1);
}
