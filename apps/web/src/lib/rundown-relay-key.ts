/** Keep today's live service on the legacy org relay used by integrations. */
export function rundownRelayKey(orgId: string, serviceDate: string | null, today: string): string {
  if (!serviceDate || serviceDate === today) return orgId;
  return `${orgId}:${serviceDate}`;
}
