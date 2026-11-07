import { getD1 } from "./d1";
import { markDatabaseWrite } from "./request-database.server";
import { scopedTokenDigest } from "./scoped-token-store.server";

interface AudioWrite {
  orgId: string;
  actorId: string;
  requestId?: string;
  kind: "create" | "update" | "delete";
  payload: unknown;
}
interface AudioWritePlan {
  assignmentId: string;
  // SQL and column names are supplied only by the server; values are bound.
  guard: string;
  guardValues: (string | number | null)[];
  statement: D1PreparedStatement;
}

/** Authenticate and check dashboard:tm before reading or writing a receipt. */
export async function runAudioWrite(command: AudioWrite, plan: () => AudioWritePlan): Promise<string> {
  const db = getD1();
  const requestId = command.requestId ?? crypto.randomUUID();
  const fingerprint = await scopedTokenDigest(JSON.stringify({ kind: command.kind, payload: command.payload }));
  const read = () => db.prepare("SELECT fingerprint,assignmentId FROM audio_write_receipt WHERE orgId=? AND actorId=? AND requestId=?")
    .bind(command.orgId, command.actorId, requestId).first<{ fingerprint: string; assignmentId: string }>();
  const recover = (receipt: NonNullable<Awaited<ReturnType<typeof read>>>) => {
    if (receipt.fingerprint !== fingerprint) throw new Error("This request belongs to different channel changes. Review the stored channels before editing again.");
    return receipt.assignmentId;
  };
  const previous = await read();
  if (previous) return recover(previous);
  const next = plan();
  markDatabaseWrite();
  try {
    await db.batch([
      db.prepare(`INSERT INTO audio_write_receipt(orgId,actorId,requestId,fingerprint,assignmentId,createdAt,precondition)
        VALUES(?,?,?,?,?,?,CASE WHEN ${next.guard} THEN 1 ELSE 0 END)`)
        .bind(command.orgId, command.actorId, requestId, fingerprint, next.assignmentId, new Date().toISOString(), ...next.guardValues),
      next.statement,
    ]);
  } catch (error) {
    // A concurrent replay loses its receipt insert and rolls back its batch.
    const saved = await read();
    if (saved) return recover(saved);
    if (error instanceof Error && error.message.includes("audio_write_precondition")) throw new Error("The channel or show is no longer available. Review the stored channels before editing again.");
    throw new Error("The channel change could not be confirmed. Retry the same action.", { cause: error });
  }
  return next.assignmentId;
}
