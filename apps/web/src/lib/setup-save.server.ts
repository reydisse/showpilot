import { setupAttemptIsActive, setupAttemptSchema, setupBatchSchema, type SetupSnapshot, type SetupTeamInput, type SetupAttempt, type SetupInvitationInput } from "./setup-save-contract";
import { generateMemberId } from "./import-members-csv";
const BATCH_KEY = "onboarding-team";
const inviteKey = (batchId: string, index: number) => `onboarding-invite:${batchId}:${index}`;
type Database = Pick<D1Database, "prepare" | "batch">;
async function setting(db: Database, orgId: string, key: string) {
  return (await db.prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?").bind(orgId, key).first<{ value: string }>())?.value ?? null;
}
export async function readSetupSnapshot(db: Database, orgId: string): Promise<SetupSnapshot> {
  const value = await setting(db, orgId, BATCH_KEY);
  const batch = value ? setupBatchSchema.parse(JSON.parse(value)) : null;
  const invitations = batch ? await Promise.all(batch.invites.map(async (_, index) => {
    const value = await setting(db, orgId, inviteKey(batch.batchId, index));
    return value ? setupAttemptSchema.parse(JSON.parse(value)) : null;
  })) : [];
  return { batch, invitations, completed: Boolean(await setting(db, orgId, "onboarding-completed")) };
}
export async function prepareSetupTeam(db: Database, input: SetupTeamInput, actorId: string) {
  const existing = await readSetupSnapshot(db, input.orgId);
  if (existing.batch) {
    if (existing.batch.batchId === input.batchId && (existing.batch.actorId !== actorId ||
      JSON.stringify(existing.batch.crew.map(({ name, pos }) => ({ name, pos }))) !== JSON.stringify(input.crew) ||
      JSON.stringify(existing.batch.invites) !== JSON.stringify(input.invites))) throw new Error("This setup request belongs to a different team.");
    return existing;
  }
  const taken = new Set((await db.prepare("SELECT memberId FROM crew_member WHERE orgId=?").bind(input.orgId).all<{ memberId: string }>()).results.map(row => row.memberId));
  const batch = { batchId: input.batchId, actorId, crew: input.crew.map(row => ({ ...row, id: crypto.randomUUID(), memberId: generateMemberId(row.name, taken) })), invites: input.invites };
  const value = JSON.stringify(batch);
  await db.batch([
    db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?) ON CONFLICT(orgId,key) DO NOTHING")
      .bind(crypto.randomUUID(), input.orgId, BATCH_KEY, value),
    ...batch.crew.map(row => db.prepare(`INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline)
      SELECT ?,?,?,?,?,'','',0 WHERE EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?)`)
      .bind(row.id, input.orgId, row.memberId, row.name, row.pos, input.orgId, BATCH_KEY, value)),
  ]);
  return readSetupSnapshot(db, input.orgId);
}
export async function claimSetupInvitation(db: Database, input: SetupInvitationInput, invitationId: string | null) {
  const key = inviteKey(input.batchId, input.index);
  const previous = await setting(db, input.orgId, key);
  if (previous) {
    const job = setupAttemptSchema.parse(JSON.parse(previous));
    if (job.attemptId === input.attemptId || setupAttemptIsActive(job) || job.state === "accepted" || job.attemptId !== input.previousAttemptId) return false;
  } else if (input.previousAttemptId) return false;
  const next: SetupAttempt = { attemptId: input.attemptId, state: "running", invitationId, occurredAt: Date.now() };
  const result = await db.prepare(`INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?)
    ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value WHERE app_setting.value=?`)
    .bind(crypto.randomUUID(), input.orgId, key, JSON.stringify(next), previous).run();
  return result.meta.changes === 1;
}
export async function recordSetupInvitation(db: Database, input: SetupInvitationInput, state: SetupAttempt["state"], invitationId: string | null) {
  const value: SetupAttempt = { attemptId: input.attemptId, state, invitationId, occurredAt: Date.now() };
  const result = await db.prepare(`UPDATE app_setting SET value=json_set(?, '$.invitationId', COALESCE(?,json_extract(value,'$.invitationId'))) WHERE orgId=? AND key=?
    AND json_extract(value,'$.attemptId')=? AND json_extract(value,'$.state')='running'`)
    .bind(JSON.stringify(value), invitationId, input.orgId, inviteKey(input.batchId, input.index), input.attemptId).run();
  if (state === "running" && result.meta.changes !== 1) throw new Error("This invitation attempt is no longer active.");
}
export async function finishSetupBatch(db: Database, orgId: string, batchId: string, allowUnconfirmed: boolean) {
  const snapshot = await readSetupSnapshot(db, orgId);
  if (snapshot.batch?.batchId !== batchId) throw new Error("Review the saved setup team before continuing.");
  if (!allowUnconfirmed && snapshot.invitations.some(job => job?.state !== "accepted")) throw new Error("Some invitations still need attention.");
  await db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?) ON CONFLICT(orgId,key) DO NOTHING")
    .bind(crypto.randomUUID(), orgId, "onboarding-completed", new Date().toISOString()).run();
  return { ok: true as const, batchId };
}
