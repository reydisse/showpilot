import type { CrewAttendanceMember } from "./crew-attendance-writes";
export type AttendanceDatabase = Pick<D1Database, "prepare" | "batch">;
export interface AttendanceRow {
  id: string; memberId: string; name: string; photoUrl: string; role: string;
  isOnline: number; lastCheckIn: string | number | null; lastCheckOut: string | number | null;
}
export async function attendanceDigest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const columns = "id,memberId,name,photoUrl,role,isOnline,lastCheckIn,lastCheckOut";
export async function readAttendanceRows(db: AttendanceDatabase, orgId: string, ids?: readonly string[]) {
  const result = ids === undefined
    ? await db.prepare(`SELECT ${columns} FROM crew_member WHERE orgId=? ORDER BY name,id`).bind(orgId).all<AttendanceRow>()
    : await db.prepare(`SELECT ${columns} FROM crew_member WHERE orgId=? AND id IN(SELECT value FROM json_each(?)) ORDER BY id`).bind(orgId, JSON.stringify(ids)).all<AttendanceRow>();
  return result.results;
}
export function readAttendanceByMemberId(db: AttendanceDatabase, orgId: string, memberId: string) {
  return db.prepare(`SELECT ${columns} FROM crew_member WHERE orgId=? AND memberId=?`).bind(orgId, memberId).first<AttendanceRow>();
}
export async function attendanceMember(row: AttendanceRow): Promise<CrewAttendanceMember> {
  const { id, isOnline, lastCheckIn, lastCheckOut, memberId, name, photoUrl, role } = row;
  return { id, memberId, name, photoUrl, role, isOnline: Boolean(isOnline), revision: await attendanceDigest({ id, isOnline, lastCheckIn, lastCheckOut }) };
}
export function attendanceChangeTime(rows: readonly AttendanceRow[]) {
  const times = rows.flatMap(row => [row.lastCheckIn, row.lastCheckOut]).map(value => {
    const time = typeof value === "number" ? value : value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time + 1 : 0;
  });
  return Math.max(Date.now(), ...times);
}
