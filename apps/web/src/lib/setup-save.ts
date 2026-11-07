import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getD1 } from "./d1";
import { getPrisma } from "./db";
import { getRequestOrgAccess } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { setupTeamInputSchema, setupInvitationInputSchema, setupAttemptIsActive } from "./setup-save-contract";
import { readSetupSnapshot, prepareSetupTeam, claimSetupInvitation, recordSetupInvitation, finishSetupBatch } from "./setup-save.server";
import { withSetupInvitationDelivery } from "./setup-invitation-delivery.server";
async function owner(orgId: string) {
  const request = await getRequestOrgAccess(orgId);
  if (request.access.role !== "owner") throw new Error("Forbidden");
  return request.user;
}
const orgInput = z.object({ orgId: idSchema });
export const getSetupTeam = createServerFn({ method: "GET" })
  .inputValidator(data => parseOrThrow(orgInput, data))
  .handler(async ({ data }) => { await owner(data.orgId); return readSetupSnapshot(getD1(), data.orgId); });
export const saveSetupTeam = createServerFn({ method: "POST" })
  .inputValidator(data => parseOrThrow(setupTeamInputSchema, data))
  .handler(async ({ data }) => { const user = await owner(data.orgId); return prepareSetupTeam(getD1(), data, user.id); });
export const sendSetupInvitation = createServerFn({ method: "POST" })
  .inputValidator(data => parseOrThrow(setupInvitationInputSchema, data))
  .handler(async ({ data }) => {
    await owner(data.orgId);
    const db = getD1();
    const snapshot = await readSetupSnapshot(db, data.orgId);
    if (snapshot.completed || snapshot.batch?.batchId !== data.batchId) throw new Error("Review the current setup team before sending invitations.");
    const row = snapshot.batch.invites[data.index];
    if (!row) throw new Error("Invitation not found in this setup team.");
    const job = snapshot.invitations[data.index];
    if (job && (job.attemptId === data.attemptId || setupAttemptIsActive(job) || job.state === "accepted")) return snapshot;
    const prisma = getPrisma();
    const pending = await prisma.invitation.findMany({ where: { organizationId: data.orgId, email: row.email, status: "pending", expiresAt: { gt: new Date() } }, take: 2 });
    const existing = pending.length === 1 && pending[0].role === row.role ? pending[0] : null;
    if (job && (!existing || job.attemptId !== data.previousAttemptId || (job.invitationId && existing.id !== job.invitationId))) {
      throw new Error("This invitation needs review in Team. Its creation or current status was not confirmed.");
    }
    if (!job && !existing) {
      const { checkPlanLimit } = await import("./plan-limits");
      const [members, invitations] = await Promise.all([
        prisma.member.count({ where: { organizationId: data.orgId } }),
        prisma.invitation.count({ where: { organizationId: data.orgId, status: "pending" } }),
      ]);
      await checkPlanLimit(data.orgId, "members", members + invitations);
    }
    if (!await claimSetupInvitation(db, data, existing?.id ?? null)) return readSetupSnapshot(db, data.orgId);
    // A pre-existing invitation is reviewed before an explicit resend.
    if (!job && existing) {
      await recordSetupInvitation(db, data, "uncertain", existing.id);
      return readSetupSnapshot(db, data.orgId);
    }
    const { getAuth } = await import("./auth");
    try {
      await withSetupInvitationDelivery({ orgId: data.orgId, email: row.email,
        record: (state, id) => recordSetupInvitation(db, data, state, id),
      }, () => getAuth().api.createInvitation({ headers: getRequestHeaders(), body: {
        organizationId: data.orgId, email: row.email, role: row.role, ...(job ? { resend: true } : {}),
      } }));
      // Missing hook evidence never counts as a successful email.
      await recordSetupInvitation(db, data, "uncertain", existing?.id ?? null);
    } catch {
      await recordSetupInvitation(db, data, "uncertain", existing?.id ?? null);
    }
    return readSetupSnapshot(db, data.orgId);
  });
export const finishSetupTeam = createServerFn({ method: "POST" })
  .inputValidator(data => parseOrThrow(orgInput.extend({ batchId: z.uuid(), allowUnconfirmed: z.boolean() }), data))
  .handler(async ({ data }) => { await owner(data.orgId); return finishSetupBatch(getD1(), data.orgId, data.batchId, data.allowUnconfirmed); });
