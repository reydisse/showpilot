import type { TimecodeShow } from "@/types/timecode";

type ShowReader = {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
};

/** The operator catalog includes past and same-day shows, independently of the
 * active output and the upcoming-only dashboard summary. Callers authorize it. */
export async function listTimecodeShows(db: ShowReader, orgId: string): Promise<TimecodeShow[]> {
  const result = await db.prepare(`SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime FROM rundown r
    WHERE r.orgId = ? AND NOT EXISTS (SELECT 1 FROM app_setting s WHERE s.orgId=r.orgId AND s.key='show-deleting:'||r.id)
    ORDER BY r.serviceDate ASC, r.scheduledStartTime ASC, r.createdAt ASC, r.id ASC`).bind(orgId).all<TimecodeShow>();
  return result.results ?? [];
}
