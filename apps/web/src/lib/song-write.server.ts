import { z } from "zod";
import { getD1 } from "./d1";
import { markDatabaseWrite } from "./request-database.server";
import { scopedTokenDigest } from "./scoped-token-store.server";

type SongWriteKind = "create" | "metadata" | "section" | "delete-section" | "reorder" | "cue-map" | "draft" | "delete" | "import";
interface SongWrite {
  orgId: string;
  actorId: string;
  requestId?: string;
  kind: SongWriteKind;
  payload: unknown;
  targetSongId?: string;
}
interface SongWritePlan<T> { songId: string; result: T; statements: D1PreparedStatement[]; }

/** The caller authenticates and checks songs:manage before entering this boundary. */
export async function runSongWrite<T>(command: SongWrite, resultSchema: z.ZodType<T>, plan: () => Promise<SongWritePlan<T>>): Promise<T> {
  const db = getD1();
  const requestId = command.requestId ?? crypto.randomUUID();
  const fingerprint = await scopedTokenDigest(JSON.stringify({ kind: command.kind, payload: command.payload }));
  const read = () => db.prepare("SELECT kind,fingerprint,songId,result FROM song_write_receipt WHERE orgId=? AND actorId=? AND requestId=?")
    .bind(command.orgId, command.actorId, requestId).first<{ kind: string; fingerprint: string; songId: string; result: string }>();
  const recover = async (receipt: NonNullable<Awaited<ReturnType<typeof read>>>) => {
    if (receipt.kind !== command.kind || receipt.fingerprint !== fingerprint) throw new Error("This request belongs to different song changes. Review the saved result before starting another change.");
    if (command.kind !== "delete" && command.kind !== "delete-section") {
      const song = await db.prepare("SELECT id FROM song WHERE id=? AND orgId=?").bind(receipt.songId, command.orgId).first();
      if (!song) throw new Error("The song saved by this request was removed. Retrying will not recreate it.");
    }
    const result = resultSchema.parse(JSON.parse(receipt.result));
    if (command.kind === "cue-map" || command.kind === "draft") {
      const { cueMapId } = z.object({ cueMapId: z.string() }).parse(result);
      const map = await db.prepare("SELECT id FROM song_cue_map WHERE id=? AND songId=? AND orgId=?")
        .bind(cueMapId, receipt.songId, command.orgId).first();
      if (!map) throw new Error("The saved cue map has been removed. Retrying will not recreate it.");
    }
    if (command.kind === "section") {
      const { id } = z.object({ id: z.string() }).parse(result);
      const section = await db.prepare("SELECT id FROM song_section WHERE id=? AND songId=? AND orgId=?")
        .bind(id, receipt.songId, command.orgId).first();
      if (!section) throw new Error("The saved section has been removed. Retrying will not recreate it.");
    }
    return result;
  };
  const previous = await read();
  if (previous) return await recover(previous);
  const revision = command.targetSongId
    ? await db.prepare("SELECT writeRevision FROM song WHERE id=? AND orgId=?").bind(command.targetSongId, command.orgId).first<{ writeRevision: number }>()
    : null;
  if (command.targetSongId && !revision) throw new Error("Song not found");
  const next = await plan();
  const result = resultSchema.parse(next.result);
  const precondition = revision && command.targetSongId
    ? db.prepare(`INSERT INTO song_write_receipt(orgId,actorId,requestId,kind,fingerprint,songId,result,createdAt,precondition)
        VALUES(?,?,?,?,?,?,?,?,CASE WHEN (SELECT writeRevision FROM song WHERE id=? AND orgId=?)=? THEN 1 ELSE 0 END)`)
      .bind(command.orgId, command.actorId, requestId, command.kind, fingerprint, next.songId, JSON.stringify(result), new Date().toISOString(), command.targetSongId, command.orgId, revision.writeRevision)
    : db.prepare(`INSERT INTO song_write_receipt(orgId,actorId,requestId,kind,fingerprint,songId,result,createdAt,precondition)
        VALUES(?,?,?,?,?,?,?,?,1)`)
      .bind(command.orgId, command.actorId, requestId, command.kind, fingerprint, next.songId, JSON.stringify(result), new Date().toISOString());
  markDatabaseWrite();
  try {
    // A racing replay conflicts on the first insert, rolling back its whole
    // batch. It reads the winning receipt without applying the edits again.
    await db.batch([precondition, ...next.statements]);
  } catch (error) {
    const saved = await read();
    if (saved) return await recover(saved);
    if (error instanceof Error && error.message.includes("song_write_precondition")) {
      throw new Error("The song changed while this request was being prepared. Review the current song and retry.");
    }
    throw new Error("The song change could not be confirmed. Retry the same action.", { cause: error });
  }
  return result;
}
