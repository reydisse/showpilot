import { NEXT_UPDATED_AT_SQL } from "./sqlite-timestamp.server";
import { z } from "zod";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { rundownDetailsAuthority } from "./rundown-details-authority.server";
import {
  rundownDetailsCommandSchema,
  type RundownDetailsCommand,
} from "./rundown-details-contract";
import { editServiceTimeToIso } from "./utils";
import {
  showDetailsCommandSchema,
  showDetailsFingerprint,
  showDetailsMetadata,
  showDetailsSnapshotSchema,
  type ShowDetailsCommand,
  type ShowDetailsResult,
  type ShowDetailsSnapshot,
} from "./show-details-contract";

export class ShowDetailsRequestError extends Error {}

type Database = Pick<D1Database, "prepare" | "batch">;
const receiptSchema = z.object({
  actorId: z.string(),
  showId: z.string(),
  fingerprint: z.string(),
  outcome: z.enum(["applied", "conflict", "cancelled", "removed"]),
  metadata: z.string().nullable(),
});
const rawSnapshotSchema = showDetailsSnapshotSchema.extend({
  scheduledStartTime: z.union([z.string(), z.number()]).nullable(),
  scheduledCallTime: z.union([z.string(), z.number()]).nullable(),
  updatedAt: z.union([z.string(), z.number()]),
});
const date = (value: string | number | null) =>
  value === null ? null : new Date(value).toISOString();
export async function readShowDetailsSnapshot(
  db: Database,
  orgId: string,
  showId: string,
) {
  const raw = await db
    .prepare(
      "SELECT id,serviceDate,name,location,scheduledStartTime,scheduledCallTime,updatedAt FROM rundown WHERE orgId=? AND id=?",
    )
    .bind(orgId, showId)
    .first();
  if (!raw) return null;
  const row = rawSnapshotSchema.parse(raw);
  const snapshot = showDetailsSnapshotSchema.parse({
    ...row,
    scheduledStartTime: date(row.scheduledStartTime),
    scheduledCallTime: date(row.scheduledCallTime),
    updatedAt: date(row.updatedAt),
  });
  return { snapshot, storedVersion: row.updatedAt };
}

/** Called only inside the show's serialized relay writer. The receipt and
 * metadata commit together; review fences requests that have not committed. */
export async function writeShowDetails(
  db: Database,
  input: ShowDetailsCommand,
  sessionId: string,
  mode: "save" | "review",
  beforeCommit: () => Promise<void>,
): Promise<ShowDetailsResult> {
  const command = showDetailsCommandSchema.parse(input);
  const access = await memberPermissionGuard(
    db,
    command.orgId,
    { userId: command.userId, sessionId },
    ["schedule:manage"],
  ).catch(() => {
    throw new ShowDetailsRequestError(
      "Your session or required permission is no longer active.",
    );
  });
  return writeDetails(
    db,
    command,
    mode,
    beforeCommit,
    access,
    showDetailsFingerprint(command),
    true,
  );
}

/** A separate entry point preserves rundown:edit and PIN access. Schedule callers
 * cannot select a weaker permission through their command payload. */
export async function writeRundownDetails(
  db: Database,
  input: RundownDetailsCommand,
  actor: { sessionId: string; pin: string | null },
  mode: "save" | "review",
  liveRevision: number,
  beforeCommit: () => Promise<void>,
): Promise<ShowDetailsResult> {
  const command = rundownDetailsCommandSchema.parse(input);
  const access = await rundownDetailsAuthority(
    db,
    command.orgId,
    { userId: command.userId, sessionId: actor.sessionId },
    actor.pin,
  );
  return writeDetails(
    db,
    command,
    mode,
    beforeCommit,
    access,
    JSON.stringify([
      "rundown",
      command.expectedRevision,
      showDetailsFingerprint(command),
    ]),
    command.expectedRevision === liveRevision,
  );
}

async function writeDetails(
  db: Database,
  command: ShowDetailsCommand,
  mode: "save" | "review",
  beforeCommit: () => Promise<void>,
  access: Pick<Awaited<ReturnType<typeof memberPermissionGuard>>, "guard" | "guardArgs">,
  fingerprint: string,
  revisionMatches: boolean,
): Promise<ShowDetailsResult> {
  const { orgId, showId, requestId, userId } = command;
  const read = `SELECT actorId,showId,fingerprint,outcome,metadata FROM show_details_request WHERE orgId=? AND requestId=? AND ${access.guard}`;
  const readArgs = [orgId, requestId, ...access.guardArgs];
  let row: unknown = await db
    .prepare(read)
    .bind(...readArgs)
    .first();
  if (!row) {
    const current =
      mode === "save" ? await readShowDetailsSnapshot(db, orgId, showId) : null;
    const timeZone =
      mode === "review"
        ? "UTC"
        : (command.timeZone ??
          (
            await db
              .prepare(
                "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
              )
              .bind(orgId)
              .first<{ value: string }>()
          )?.value ??
          "UTC");
    const values = {
      serviceDate: command.serviceDate,
      name: command.name,
      location: command.location,
      scheduledStartTime:
        mode === "review"
          ? null
          : editServiceTimeToIso({
              serviceDate: command.serviceDate,
              time: command.startTime,
              timeZone,
              referenceTime: current?.snapshot.scheduledStartTime,
            }),
      scheduledCallTime:
        mode === "review"
          ? null
          : editServiceTimeToIso({
              serviceDate: command.serviceDate,
              time: command.callTime,
              timeZone,
              referenceTime:
                current?.snapshot.scheduledCallTime ??
                current?.snapshot.scheduledStartTime,
            }),
    };
    const candidate =
      mode === "save" &&
      revisionMatches &&
      current?.snapshot.updatedAt ===
        new Date(command.expectedUpdatedAt).toISOString();
    const nonce = crypto.randomUUID();
    const owns =
      "EXISTS(SELECT 1 FROM show_details_request WHERE orgId=? AND requestId=? AND nonce=? AND outcome='applied')";
    const ownsArgs = [orgId, requestId, nonce];
    // This tiny durable intent bridges a crash between D1 commit and DO state.
    await beforeCommit();
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO show_details_request(orgId,requestId,actorId,showId,fingerprint,nonce,outcome,metadata,createdAt)
        SELECT ?,?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled'
          WHEN NOT EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=?) THEN 'removed'
          WHEN ?=1 AND EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=? AND updatedAt=?
            AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=rundown.orgId AND key='show-deleting:'||rundown.id)) THEN 'applied'
          ELSE 'conflict' END,?,? WHERE ${access.guard} ON CONFLICT(orgId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          requestId,
          userId,
          showId,
          fingerprint,
          nonce,
          mode,
          orgId,
          showId,
          candidate ? 1 : 0,
          orgId,
          showId,
          command.serviceDate,
          current?.storedVersion ?? "",
          showDetailsMetadata(values),
          Date.now(),
          ...access.guardArgs,
        ),
      db
        .prepare(
          `UPDATE rundown SET name=?,scheduledStartTime=?,scheduledCallTime=?,location=?,
        updatedAt=${NEXT_UPDATED_AT_SQL}
        WHERE orgId=? AND id=? AND ${owns}`,
        )
        .bind(
          values.name,
          values.scheduledStartTime,
          values.scheduledCallTime,
          values.location,
          orgId,
          showId,
          ...ownsArgs,
        ),
      db.prepare(read).bind(...readArgs),
    ]);
    row = results[2].results[0];
  }
  if (!row)
    throw new ShowDetailsRequestError(
      "Your session or required permission is no longer active.",
    );
  const receipt = receiptSchema.parse(row);
  if (
    receipt.actorId !== userId ||
    receipt.showId !== showId ||
    receipt.fingerprint !== fingerprint
  )
    throw new ShowDetailsRequestError(
      "This save request belongs to different details or an account. The original show was not changed.",
    );
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new ShowDetailsRequestError(
      "Your session or required permission is no longer active.",
    );
  const snapshot =
    (await readShowDetailsSnapshot(db, orgId, showId))?.snapshot ?? null;
  let outcome: ShowDetailsResult["outcome"] = receipt.outcome;
  if (outcome === "applied")
    outcome = !snapshot
      ? "removed"
      : showDetailsMetadata(snapshot) === receipt.metadata
        ? "applied"
        : "superseded";
  return { requestId, showId, outcome, snapshot };
}

export type PendingShowDetails = {
  orgId: string;
  showId: string;
  requestId: string;
  actorId: string;
  revision: number;
};
/** Recovery reads only committed rows. It never replays an old metadata payload. */
export async function readCommittedShowDetails(
  db: Database,
  pending: PendingShowDetails,
): Promise<ShowDetailsSnapshot | null> {
  const receipt = await db
    .prepare(
      "SELECT outcome FROM show_details_request WHERE orgId=? AND requestId=? AND showId=? AND actorId=?",
    )
    .bind(pending.orgId, pending.requestId, pending.showId, pending.actorId)
    .first<{ outcome: string }>();
  if (receipt?.outcome !== "applied") return null;
  return (
    (await readShowDetailsSnapshot(db, pending.orgId, pending.showId))
      ?.snapshot ?? null
  );
}
