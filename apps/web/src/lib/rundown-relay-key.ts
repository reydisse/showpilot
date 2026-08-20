/**
 * Stable show instances get isolated rooms. Unmigrated integrations retain
 * the legacy date/org behavior when no show ID is available.
 */
export function rundownRelayKey(
  orgId: string,
  serviceDate: string | null,
  today: string,
  showId?: string | null,
): string {
  if (showId) return `${orgId}:show:${showId}`;
  if (!serviceDate || serviceDate === today) return orgId;
  return `${orgId}:${serviceDate}`;
}
