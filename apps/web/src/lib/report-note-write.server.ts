import type {
  ReportNoteWrite,
  ReportNoteWriteResult,
} from "./report-note-write";
import type { ShowReportNote } from "./show-report-notes";
import { scopedTokenDigest } from "./scoped-token-store.server";

/** Call only after rechecking member access and the role-specific note grant.
 * The receipt and conditional save share one transaction. Replays read the
 * original outcome and current note without writing again.
 */
export async function applyReportNoteWrite(
  db: Pick<D1Database, "prepare" | "batch">,
  input: ReportNoteWrite,
  actor: { id: string; name: string },
): Promise<ReportNoteWriteResult> {
  const {
    orgId,
    requestId,
    showId,
    expectedRevision,
    role,
    summary,
    wins,
    issues,
    followUps,
  } = input;
  const fingerprint = await scopedTokenDigest(
    JSON.stringify({
      showId,
      expectedRevision,
      role,
      summary,
      wins,
      issues,
      followUps,
    }),
  );
  const claimId = crypto.randomUUID();
  const identity = [orgId, showId, actor.id, role];
  const noteWhere = "orgId = ? AND showId = ? AND userId = ? AND role = ?";
  const condition =
    expectedRevision === null
      ? `NOT EXISTS (SELECT 1 FROM show_report_note WHERE ${noteWhere})`
      : `EXISTS (SELECT 1 FROM show_report_note WHERE ${noteWhere} AND revision = ?)`;
  const conditionValues =
    expectedRevision === null ? identity : [...identity, expectedRevision];
  await db.batch([
    db
      .prepare(
        `INSERT INTO report_note_write_receipt(orgId,actorId,requestId,fingerprint,claimId,outcome)
      VALUES (?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=?) AND ${condition} THEN 'applied' ELSE 'conflict' END)
      ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
      )
      .bind(
        orgId,
        actor.id,
        requestId,
        fingerprint,
        claimId,
        orgId,
        showId,
        ...conditionValues,
      ),
    db
      .prepare(
        `INSERT INTO show_report_note(id,orgId,showId,userId,authorName,role,summary,wins,issues,followUps,createdAt,updatedAt)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM report_note_write_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=? AND outcome='applied'
      ) ON CONFLICT(orgId,showId,userId,role) DO UPDATE SET
        authorName=excluded.authorName,summary=excluded.summary,wins=excluded.wins,issues=excluded.issues,followUps=excluded.followUps,updatedAt=excluded.updatedAt`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        showId,
        actor.id,
        actor.name,
        role,
        summary,
        wins,
        issues,
        followUps,
        new Date().toISOString(),
        new Date().toISOString(),
        orgId,
        actor.id,
        requestId,
        claimId,
      ),
  ]);
  const saved = await db
    .prepare(
      "SELECT fingerprint,outcome FROM report_note_write_receipt WHERE orgId=? AND actorId=? AND requestId=?",
    )
    .bind(orgId, actor.id, requestId)
    .first<{ fingerprint: string; outcome: string }>();
  if (!saved || saved.fingerprint !== fingerprint)
    throw new Error("This request belongs to a different report note change.");
  if (saved.outcome !== "applied" && saved.outcome !== "conflict")
    throw new Error("The report note result could not be confirmed.");
  const currentNote = await db
    .prepare(
      `SELECT id,showId,userId,authorName,role,summary,wins,issues,followUps,revision,createdAt,updatedAt FROM show_report_note WHERE ${noteWhere}`,
    )
    .bind(...identity)
    .first<ShowReportNote>();
  return { requestId, outcome: saved.outcome, currentNote };
}
