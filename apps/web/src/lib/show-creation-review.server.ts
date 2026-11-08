import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  reviewShowCreationSchema,
  showCreationFingerprint,
  type ShowCreationReview,
} from "./show-creation-contract";
import type { z } from "zod";

export async function reviewShowCreationRequest(
  headers: Headers,
  input: z.infer<typeof reviewShowCreationSchema>,
  db: Pick<D1Database, "prepare" | "batch"> = getD1(),
): Promise<ShowCreationReview> {
  const data = reviewShowCreationSchema.parse(input);
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== data.userId)
    throw new Error(
      "Your account changed. Reopen this form before reviewing the request.",
    );
  const access = await memberPermissionGuard(
    db,
    data.orgId,
    { userId: session.user.id, sessionId: session.session.id },
    ["schedule:manage"],
  );
  const fingerprint = showCreationFingerprint(data),
    now = Date.now();
  markDatabaseWrite();
  const result = await db.batch<{
    actorId: string;
    fingerprint: string;
    cancelledAt: number | null;
    serviceDate: string;
    showId: string | null;
  }>([
    db
      .prepare(
        `INSERT INTO show_creation_request(orgId,requestId,actorId,fingerprint,nonce,serviceDate,createdAt,cancelledAt)
      SELECT ?,?,?,?,?,?,?,? WHERE ${access.guard} AND NOT EXISTS(SELECT 1 FROM rundown WHERE id=?) ON CONFLICT(orgId,requestId) DO NOTHING`,
      )
      .bind(
        data.orgId,
        data.requestId,
        data.userId,
        fingerprint,
        crypto.randomUUID(),
        data.serviceDate,
        now,
        now,
        ...access.guardArgs,
        data.requestId,
      ),
    db
      .prepare(
        `SELECT r.actorId,r.fingerprint,r.cancelledAt,r.serviceDate,s.id AS showId FROM show_creation_request r
      LEFT JOIN rundown s ON s.orgId=r.orgId AND s.id=r.requestId
      WHERE r.orgId=? AND r.requestId=? AND ${access.guard}`,
      )
      .bind(data.orgId, data.requestId, ...access.guardArgs),
  ]);
  const receipt = result[1].results[0];
  if (!receipt)
    throw new Error(
      "The original request could not be settled. Check your access and the show list before trying again.",
    );
  if (receipt.actorId !== data.userId || receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request belongs to different details or an account. The original show was not changed.",
    );
  if (receipt.cancelledAt !== null) return { kind: "cancelled" };
  if (!receipt.showId) return { kind: "removed" };
  return {
    kind: "created",
    result: {
      ok: true,
      showId: receipt.showId,
      serviceDate: receipt.serviceDate,
    },
  };
}
