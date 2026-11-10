import { z } from "zod";
import { idSchema } from "./validation";
import { crewSchema, inviteSchema } from "./setup-team";
export const setupTeamInputSchema = z.object({
  orgId: idSchema, batchId: z.uuid(), crew: z.array(crewSchema).max(4), invites: z.array(inviteSchema).max(3),
}).refine(input => new Set(input.invites.map(row => row.email)).size === input.invites.length, "Keep one invitation per email address.");
export type SetupTeamInput = z.infer<typeof setupTeamInputSchema>;
export const setupBatchSchema = z.object({
  batchId: z.uuid(), actorId: idSchema,
  crew: z.array(crewSchema.extend({ id: z.uuid(), memberId: idSchema })).max(4),
  invites: z.array(inviteSchema).max(3),
});
export type SetupBatch = z.infer<typeof setupBatchSchema>;
export const setupAttemptSchema = z.object({
  attemptId: z.uuid(), state: z.enum(["running", "accepted", "failed", "uncertain"]),
  invitationId: idSchema.nullable(), occurredAt: z.number(),
}).refine(job => (job.state !== "accepted" && job.state !== "failed") || job.invitationId !== null, "Delivery evidence requires an invitation record.");
export type SetupAttempt = z.infer<typeof setupAttemptSchema>;
export const setupSnapshotSchema = z.object({ batch: setupBatchSchema.nullable(), invitations: z.array(setupAttemptSchema.nullable()).max(3), completed: z.boolean() })
  .refine(value => value.invitations.length === (value.batch?.invites.length ?? 0), "Incomplete setup acknowledgement.");
export type SetupSnapshot = z.infer<typeof setupSnapshotSchema>;
export const setupAttemptIsActive = (job: SetupAttempt) => job.state === "running" && Date.now() - job.occurredAt < 15_000;
export const setupInvitationInputSchema = z.object({
  orgId: idSchema, batchId: z.uuid(), index: z.number().int().min(0).max(2), attemptId: z.uuid(), previousAttemptId: z.uuid().nullable(),
});
export type SetupInvitationInput = z.infer<typeof setupInvitationInputSchema>;
