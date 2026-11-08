import { env } from "cloudflare:workers";
import { z } from "zod";
import { getD1 } from "./d1";
import { CredentialVault } from "./credential-vault.server";
import { sendEmail, EmailDeliveryRejected } from "./email";
import { runRouteLoad } from "./route-load-deadlines";
import { markDatabaseWrite } from "./request-database.server";

export type InvitationGuard = { sql: string; args: (string | number | null)[] };
const storedSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  payload: z.string(),
  accessId: z.string(),
  state: z.enum(["ready", "sending", "accepted", "failed", "uncertain"]),
  inAppDelivered: z.number(),
  firstSentAt: z.number().nullable(),
  leaseUntil: z.number().nullable(),
  updatedAt: z.number(),
});
const emailSchema = z
  .object({ to: z.string().email(), subject: z.string(), html: z.string() })
  .strict();
export type ScheduleEmailState =
  | "accepted"
  | "failed"
  | "uncertain"
  | "sending"
  | "expired"
  | "changed";
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const LEASE = 30_000;
export async function deliverScheduleInvitation(input: {
  orgId: string;
  assignmentId: string;
  crewMemberId: string;
  requestId: string;
  origin: string;
  fingerprint: string;
  guard: InvitationGuard;
  render: (link: string) => z.infer<typeof emailSchema>;
  notify: (deliveryId: string) => Promise<boolean>;
}) {
  const db = getD1();
  const read = async () => {
    const row = await db
      .prepare(
        "SELECT * FROM schedule_invitation_delivery WHERE orgId=? AND assignmentId=? AND requestId=?",
      )
      .bind(input.orgId, input.assignmentId, input.requestId)
      .first();
    return row ? storedSchema.parse(row) : null;
  };
  const reply = (
    state: ScheduleEmailState,
    inAppDelivered: boolean,
    at: number,
  ) => ({
    delivered: state === "accepted" || inAppDelivered,
    reason:
      state === "accepted"
        ? null
        : state === "changed"
          ? "assignment-changed"
          : state === "expired"
            ? "retry-window-expired"
            : "email-" + state,
    emailState: state,
    inAppDelivered,
    requestId: input.requestId,
    updatedAt: at,
  });
  let row = await read();
  const vault = await CredentialVault.fromSecret(
    env.CREDENTIAL_ENCRYPTION_KEYS,
  );
  if (!row) {
    const id = crypto.randomUUID(),
      accessId = crypto.randomUUID();
    const token = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const payload = await vault.encrypt(
      { kind: "schedule-invitation", orgId: input.orgId, deliveryId: id },
      JSON.stringify(input.render(`${input.origin}/crew/schedule/${token}`)),
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO schedule_invitation_delivery(id,orgId,assignmentId,crewMemberId,requestId,fingerprint,payload,accessId,state,updatedAt)
        SELECT ?,?,?,?,?,?,?,?,'ready',? WHERE ${input.guard.sql} ON CONFLICT(orgId,assignmentId,requestId) DO NOTHING`,
        )
        .bind(
          id,
          input.orgId,
          input.assignmentId,
          input.crewMemberId,
          input.requestId,
          input.fingerprint,
          payload,
          accessId,
          Date.now(),
          ...input.guard.args,
        ),
      db
        .prepare(
          `INSERT INTO crew_schedule_access(id,orgId,crewMemberId,tokenHash,expiresAt,assignmentId)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM schedule_invitation_delivery WHERE orgId=? AND id=?)`,
        )
        .bind(
          accessId,
          input.orgId,
          input.crewMemberId,
          hash,
          new Date(Date.now() + 90 * 86_400_000).toISOString(),
          input.assignmentId,
          input.orgId,
          id,
        ),
    ]);
    row = await read();
  }
  if (!row || row.fingerprint !== input.fingerprint)
    return reply("changed", false, Date.now());
  if (row.state === "accepted")
    return reply("accepted", !!row.inAppDelivered, row.updatedAt);
  if (row.firstSentAt !== null && Date.now() - row.firstSentAt >= RETRY_WINDOW)
    return reply("expired", !!row.inAppDelivered, row.updatedAt);
  const scope = {
    kind: "schedule-invitation",
    orgId: input.orgId,
    deliveryId: row.id,
  } as const;
  const payload = emailSchema.parse(
    JSON.parse(await vault.decrypt(scope, row.payload)),
  );
  const nonce = crypto.randomUUID(),
    now = Date.now();
  const claim = await db
    .prepare(
      `UPDATE schedule_invitation_delivery SET state='sending',leaseNonce=?,leaseUntil=?,firstSentAt=COALESCE(firstSentAt,?),updatedAt=?
    WHERE orgId=? AND id=? AND state<>'accepted' AND (leaseUntil IS NULL OR leaseUntil<=?) AND (firstSentAt IS NULL OR firstSentAt>?)
    AND EXISTS(SELECT 1 FROM crew_schedule_access WHERE orgId=? AND id=? AND revokedAt IS NULL AND expiresAt>?) AND ${input.guard.sql}`,
    )
    .bind(
      nonce,
      now + LEASE,
      now,
      now,
      input.orgId,
      row.id,
      now,
      now - RETRY_WINDOW,
      input.orgId,
      row.accessId,
      new Date().toISOString(),
      ...input.guard.args,
    )
    .run();
  if (claim.meta.changes !== 1) {
    const current = await read();
    if (current?.state === "accepted")
      return reply("accepted", !!current.inAppDelivered, current.updatedAt);
    return reply(
      current?.leaseUntil && current.leaseUntil > now ? "sending" : "changed",
      !!current?.inAppDelivered,
      current?.updatedAt ?? now,
    );
  }
  markDatabaseWrite();
  let inAppDelivered = !!row.inAppDelivered;
  // Both channels have independent outcomes. An app invitation is not evidence
  // that an email was accepted, and a timeout never invalidates its frozen link.
  if (!inAppDelivered) {
    try {
      inAppDelivered = await runRouteLoad(
        () => input.notify(row.id),
        undefined,
        3_000,
      );
    } catch {
      /* Email and the durable result below still surface delivery state. */
    }
  }
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${input.guard.sql}`)
      .bind(...input.guard.args)
      .first())
  ) {
    await db
      .prepare(
        "UPDATE schedule_invitation_delivery SET state='ready',inAppDelivered=?,leaseNonce=NULL,leaseUntil=NULL,updatedAt=? WHERE orgId=? AND id=? AND leaseNonce=?",
      )
      .bind(Number(inAppDelivered), Date.now(), input.orgId, row.id, nonce)
      .run();
    return reply("changed", inAppDelivered, Date.now());
  }
  let state: "accepted" | "failed" | "uncertain";
  try {
    await runRouteLoad(
      (controller) =>
        sendEmail({
          ...payload,
          signal: controller.signal,
          idempotencyKey: `schedule-invitation/${row.id}`,
        }),
      undefined,
      8_000,
    );
    state = "accepted";
  } catch (error) {
    state = error instanceof EmailDeliveryRejected ? "failed" : "uncertain";
  }
  await db.batch([
    db
      .prepare(
        "UPDATE schedule_invitation_delivery SET state=?,inAppDelivered=?,leaseNonce=NULL,leaseUntil=NULL,updatedAt=? WHERE orgId=? AND id=? AND leaseNonce=?",
      )
      .bind(
        state,
        Number(inAppDelivered),
        Date.now(),
        input.orgId,
        row.id,
        nonce,
      ),
    db
      .prepare(
        `UPDATE service_assignment SET invitedAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=? AND crewMemberId=? AND status='assigned'
      AND EXISTS(SELECT 1 FROM schedule_invitation_delivery WHERE orgId=? AND id=? AND (state='accepted' OR inAppDelivered=1)) AND ${input.guard.sql}`,
      )
      .bind(
        input.orgId,
        input.assignmentId,
        input.crewMemberId,
        input.orgId,
        row.id,
        ...input.guard.args,
      ),
  ]);
  return reply(state, inAppDelivered, Date.now());
}
