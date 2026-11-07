import type { PublicAttendanceResult, PublicAttendanceWrite, PublicCrewMember } from "./public-checkin";

import { attendanceDigest as digest, readAttendanceByMemberId as readMember, attendanceMember, attendanceChangeTime, type AttendanceDatabase as Database, type AttendanceRow as MemberRow } from "./attendance-state.server";
async function publicMember(row: MemberRow | null): Promise<PublicCrewMember | null> {
  if (!row) return null;
  const { id: _id, ...member } = await attendanceMember(row);
  return member;
}
export async function getPublicAttendanceMember(db: Database, orgId: string, memberId: string) {
  return publicMember(await readMember(db, orgId, memberId));
}

/** A receipt and its conditional attendance change commit in one transaction. */
export async function applyPublicAttendanceIntent(db: Database, orgId: string, input: PublicAttendanceWrite): Promise<PublicAttendanceResult> {
  const { memberId, intent, expectedRevision, requestId } = input;
  const fingerprint = await digest({ memberId, intent, expectedRevision });
  const receiptKey = `public-attendance:${requestId}`;
  const readReceipt = async (): Promise<PublicAttendanceResult | null> => {
    const receipt = await db.prepare(`SELECT json_extract(value,'$.fingerprint') AS fingerprint,
      json_extract(value,'$.outcome') AS outcome FROM app_setting WHERE orgId=? AND key=?`)
      .bind(orgId, receiptKey).first<{ fingerprint: string; outcome: string }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw new Error("This request belongs to a different attendance change. Start again with your member ID.");
    if (receipt.outcome !== "applied" && receipt.outcome !== "conflict") throw new Error("Attendance confirmation is unavailable. Retry the same change.");
    return { requestId, outcome: receipt.outcome, member: await getPublicAttendanceMember(db, orgId, memberId) };
  };
  const prior = await readReceipt();
  if (prior) return prior;
  const row = await readMember(db, orgId, memberId);
  const matchesRevision = (await publicMember(row))?.revision === expectedRevision;
  const token = crypto.randomUUID();
  const applied = JSON.stringify({ fingerprint, token, outcome: "applied" });
  const conflict = JSON.stringify({ fingerprint, token, outcome: "conflict" });
  const changedAt = attendanceChangeTime(row ? [row] : []);
  const desiredOnline = intent === "check-in" ? 1 : 0;
  await db.batch([
    db.prepare(`INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,
      CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND memberId=? AND id=?
        AND isOnline=? AND lastCheckIn IS ? AND lastCheckOut IS ?) THEN ? ELSE ? END)
      ON CONFLICT(orgId,key) DO NOTHING`).bind(crypto.randomUUID(), orgId, receiptKey, matchesRevision ? 1 : 0,
        orgId, memberId, row?.id ?? "", row?.isOnline ?? 0, row?.lastCheckIn ?? null, row?.lastCheckOut ?? null, applied, conflict),
    db.prepare(`UPDATE crew_member SET isOnline=?,
      lastCheckIn=CASE WHEN ?=1 AND isOnline=0 THEN ? ELSE lastCheckIn END,
      lastCheckOut=CASE WHEN ?=0 AND isOnline=1 THEN ? ELSE lastCheckOut END
      WHERE orgId=? AND memberId=? AND id=? AND EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?)`)
      .bind(desiredOnline, desiredOnline, changedAt, desiredOnline, changedAt, orgId, memberId, row?.id ?? "", orgId, receiptKey, applied),
  ]);
  const result = await readReceipt();
  if (!result) throw new Error("Attendance was not confirmed. Retry the same change.");
  return result;
}
