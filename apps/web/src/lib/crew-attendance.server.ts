import { attendanceChangeTime, attendanceDigest, attendanceMember, readAttendanceRows, type AttendanceDatabase } from "./attendance-state.server";
import type { CrewAttendanceResult, CrewAttendanceWrite } from "./crew-attendance-writes";

/** One receipt guards the whole captured crew selection; a stale member rejects the batch. */
export async function applyCrewAttendance(db: AttendanceDatabase, input: CrewAttendanceWrite, userId: string): Promise<CrewAttendanceResult> {
  const { orgId, requestId, isOnline } = input;
  const members = [...input.members].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fingerprint = await attendanceDigest({ userId, isOnline, members });
  const receiptKey = `attendance-write:${requestId}`;
  const readReceipt = async (): Promise<CrewAttendanceResult | null> => {
    const receipt = await db.prepare(`SELECT json_extract(value,'$.fingerprint') AS fingerprint,
      json_extract(value,'$.outcome') AS outcome, json_extract(value,'$.changedCount') AS changedCount
      FROM app_setting WHERE orgId=? AND key=?`).bind(orgId, receiptKey)
      .first<{ fingerprint: string; outcome: string; changedCount: number }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new Error("This request belongs to a different attendance change.");
    if ((receipt.outcome !== "applied" && receipt.outcome !== "conflict") || !Number.isInteger(receipt.changedCount)) throw new Error("Attendance acknowledgement is unavailable.");
    return { requestId, outcome: receipt.outcome, changedCount: receipt.changedCount };
  };
  const prior = await readReceipt(); if (prior) return prior;
  const rows = await readAttendanceRows(db, orgId, members.map(member => member.id));
  const current = new Map((await Promise.all(rows.map(attendanceMember))).map(member => [member.id, member.revision]));
  const matches = members.every(member => current.get(member.id) === member.expectedRevision);
  const snapshot = JSON.stringify(rows.map(({ id, isOnline, lastCheckIn, lastCheckOut }) => ({ id, isOnline, lastCheckIn, lastCheckOut })));
  const token = crypto.randomUUID();
  const changedCount = rows.filter(row => Boolean(row.isOnline) !== isOnline).length;
  const applied = JSON.stringify({ fingerprint, token, outcome: "applied", changedCount });
  const conflict = JSON.stringify({ fingerprint, token, outcome: "conflict", changedCount: 0 });
  const desired = isOnline ? 1 : 0, changedAt = attendanceChangeTime(rows);
  await db.batch([
    db.prepare(`INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,CASE WHEN ?=1 AND NOT EXISTS(
      SELECT 1 FROM json_each(?) expected LEFT JOIN crew_member c ON c.orgId=? AND c.id=json_extract(expected.value,'$.id')
      WHERE c.id IS NULL OR c.isOnline IS NOT json_extract(expected.value,'$.isOnline')
        OR c.lastCheckIn IS NOT json_extract(expected.value,'$.lastCheckIn')
        OR c.lastCheckOut IS NOT json_extract(expected.value,'$.lastCheckOut')
    ) THEN ? ELSE ? END) ON CONFLICT(orgId,key) DO NOTHING`)
      .bind(crypto.randomUUID(), orgId, receiptKey, matches ? 1 : 0, snapshot, orgId, applied, conflict),
    db.prepare(`UPDATE crew_member SET isOnline=?,
      lastCheckIn=CASE WHEN ?=1 AND isOnline=0 THEN ? ELSE lastCheckIn END,
      lastCheckOut=CASE WHEN ?=0 AND isOnline=1 THEN ? ELSE lastCheckOut END
      WHERE orgId=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?))
        AND EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?)`)
      .bind(desired, desired, changedAt, desired, changedAt, orgId, snapshot, orgId, receiptKey, applied),
  ]);
  const result = await readReceipt(); if (!result) throw new Error("Attendance was not confirmed.");
  return result;
}
