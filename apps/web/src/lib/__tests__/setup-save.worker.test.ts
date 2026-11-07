import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { prepareSetupTeam, readSetupSnapshot, claimSetupInvitation, recordSetupInvitation } from "../setup-save.server";
import { saveSetupTeam, getSetupTeam, sendSetupInvitation, finishSetupTeam } from "../setup-save";
import type { SetupInvitationInput } from "../setup-save-contract";
const auth = vi.hoisted(() => ({ cookie: "", delivery: "accept", sends: 0, ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("../email", async importOriginal => {
  const actual = await importOriginal<typeof import("../email")>();
  return { ...actual, sendEmail: async () => {
    auth.sends++;
    if (auth.delivery === "reject") throw new actual.EmailDeliveryRejected("Fixture provider rejected");
    if (auth.delivery === "lost") throw new Error("Provider outcome unknown");
  } };
});
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: auth.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => { let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
beforeEach(() => { auth.delivery = "accept"; auth.sends = 0; auth.cookie = ""; });
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-setup-password-92!";
  await getPrisma().account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${++auth.ip}` }, body: JSON.stringify({ email: `${userId}@example.test`, password }) }));
  expect(login.status).toBe(200); await login.arrayBuffer(); auth.cookie = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const input = { orgId, batchId: crypto.randomUUID(), crew: [{ name: "First crew", pos: "Camera" }, { name: "Second crew", pos: "A1" }], invites: [{ email: "lead@example.test", role: "member" as const }] };
  const attempt = (): SetupInvitationInput => ({ orgId, batchId: input.batchId, index: 0, attemptId: crypto.randomUUID(), previousAttemptId: null });
  const crew = () => getPrisma().crewMember.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  return { orgId, userId, input, attempt, crew };
}
it("atomically creates crew once and resumes the durable team without resurrecting deleted people", async () => {
  const f = await fixture(); const first = await saveSetupTeam({ data: f.input });
  expect(first.batch?.crew).toHaveLength(2); const people = await f.crew(); expect(people).toHaveLength(2);
  await getPrisma().crewMember.delete({ where: { id: people[0].id } });
  expect((await saveSetupTeam({ data: f.input })).batch).toEqual(first.batch); expect(await f.crew()).toHaveLength(1);
  const competing = await saveSetupTeam({ data: { ...f.input, batchId: crypto.randomUUID(), crew: [{ name: "Other draft", pos: "Lighting" }] } });
  expect(competing.batch).toEqual(first.batch); expect(await f.crew()).toHaveLength(1);
  await expect(saveSetupTeam({ data: { ...f.input, crew: [] } })).rejects.toThrow("different team");
});
it("chooses one concurrent setup batch and one invocation per invitation attempt", async () => {
  const f = await fixture(); const results = await Promise.all([saveSetupTeam({ data: f.input }), saveSetupTeam({ data: { ...f.input, batchId: crypto.randomUUID() } })]);
  expect(results[0].batch).toEqual(results[1].batch); expect(await f.crew()).toHaveLength(2);
  const attempt = { ...f.attempt(), batchId: results[0].batch!.batchId };
  await Promise.all([sendSetupInvitation({ data: attempt }), sendSetupInvitation({ data: attempt })]);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1); expect(auth.sends).toBe(1);
  expect((await getSetupTeam({ data: { orgId: f.orgId } })).invitations[0]?.state).toBe("accepted");
});
it("rolls back the crew and setup receipt together on a transaction failure", async () => {
  const f = await fixture(); const failing = { prepare: env.DB.prepare.bind(env.DB), batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>([...statements, env.DB.prepare("SELECT * FROM fixture_missing_table")]) };
  await expect(prepareSetupTeam(failing, f.input, f.userId)).rejects.toThrow();
  expect((await readSetupSnapshot(env.DB, f.orgId)).batch).toBeNull(); expect(await f.crew()).toHaveLength(0);
  await saveSetupTeam({ data: f.input }); expect(await f.crew()).toHaveLength(2);
});
it("keeps rejected delivery visible even when the auth API returns a successful invitation", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); auth.delivery = "reject";
  const attempt = f.attempt(); const result = await sendSetupInvitation({ data: attempt });
  expect(result.invitations[0]).toMatchObject({ state: "failed", invitationId: expect.any(String) });
  expect((await getPrisma().invitation.findMany({ where: { organizationId: f.orgId } }))).toHaveLength(1);
  await expect(finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: false } })).rejects.toThrow("need attention");
  await sendSetupInvitation({ data: attempt }); expect(auth.sends).toBe(1); expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
  auth.delivery = "accept";
  const retry = { ...attempt, previousAttemptId: attempt.attemptId, attemptId: crypto.randomUUID() };
  const resent = await sendSetupInvitation({ data: retry });
  expect(resent.invitations[0]?.state).toBe("accepted"); expect(auth.sends).toBe(2); expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1); expect(await f.crew()).toHaveLength(2);
  await sendSetupInvitation({ data: retry }); expect(auth.sends).toBe(2);
  expect(await finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: false } })).toEqual({ ok: true, batchId: f.input.batchId });
});
it("does not turn a lost provider acknowledgement into delivery success", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); auth.delivery = "lost";
  const result = await sendSetupInvitation({ data: f.attempt() }); expect(result.invitations[0]).toMatchObject({ state: "uncertain", invitationId: expect.any(String) });
  expect((await getSetupTeam({ data: { orgId: f.orgId } })).completed).toBe(false);
});
it("requires an explicit decision to finish with missing or unresolved invitations", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input });
  await expect(finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: false } })).rejects.toThrow();
  await finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: true } });
  const marker = await getPrisma().appSetting.findFirst({ where: { orgId: f.orgId, key: "onboarding-completed" } });
  await finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: true } });
  expect(await getPrisma().appSetting.findFirst({ where: { orgId: f.orgId, key: "onboarding-completed" } })).toEqual(marker);
  await expect(sendSetupInvitation({ data: f.attempt() })).rejects.toThrow("current setup team");
});
it("prevents late delivery callbacks from replacing a newer retry result", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); const old = f.attempt();
  expect(await claimSetupInvitation(env.DB, old, "fixture-invitation")).toBe(true);
  await recordSetupInvitation(env.DB, old, "failed", "fixture-invitation");
  const next = { ...old, attemptId: crypto.randomUUID(), previousAttemptId: old.attemptId };
  expect(await claimSetupInvitation(env.DB, next, "fixture-invitation")).toBe(true);
  await expect(recordSetupInvitation(env.DB, old, "running", "fixture-invitation")).rejects.toThrow("no longer active");
  await recordSetupInvitation(env.DB, old, "accepted", "fixture-invitation");
  expect((await readSetupSnapshot(env.DB, f.orgId)).invitations[0]).toMatchObject({ attemptId: next.attemptId, state: "running" });
  await recordSetupInvitation(env.DB, next, "accepted", "fixture-invitation");
  await recordSetupInvitation(env.DB, next, "uncertain", null);
  expect((await readSetupSnapshot(env.DB, f.orgId)).invitations[0]).toMatchObject({ state: "accepted", invitationId: "fixture-invitation" });
});
it("rechecks owner access on reads, saves, invitation attempts and completion", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input });
  await env.DB.prepare("UPDATE member SET role='admin' WHERE organizationId=? AND userId=?").bind(f.orgId, f.userId).run();
  for (const action of [() => getSetupTeam({ data: { orgId: f.orgId } }), () => saveSetupTeam({ data: f.input }), () => sendSetupInvitation({ data: f.attempt() }), () => finishSetupTeam({ data: { orgId: f.orgId, batchId: f.input.batchId, allowUnconfirmed: true } })]) await expect(action()).rejects.toThrow("Forbidden");
  auth.cookie = ""; await expect(getSetupTeam({ data: { orgId: f.orgId } })).rejects.toThrow("Unauthorized");
});
it("rejects foreign batches, invalid payloads and duplicate recipient addresses", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); const other = await fixture();
  await expect(sendSetupInvitation({ data: f.attempt() })).rejects.toThrow("Forbidden");
  await expect(finishSetupTeam({ data: { orgId: other.orgId, batchId: f.input.batchId, allowUnconfirmed: true } })).rejects.toThrow("Review");
  await expect(saveSetupTeam({ data: { ...other.input, crew: [{ name: " ", pos: "" }] } })).rejects.toThrow();
  await expect(saveSetupTeam({ data: { ...other.input, invites: [other.input.invites[0], other.input.invites[0]] } })).rejects.toThrow("one invitation");
  expect(await other.crew()).toHaveLength(0);
});
it("does not resend an existing invitation until the operator explicitly retries it", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input });
  await getPrisma().invitation.create({ data: { id: crypto.randomUUID(), organizationId: f.orgId, email: "lead@example.test", role: "member", inviterId: f.userId, expiresAt: new Date(Date.now()+86_400_000) } });
  const attempt = f.attempt(); const result = await sendSetupInvitation({ data: attempt });
  expect(result.invitations[0]?.state).toBe("uncertain"); expect(auth.sends).toBe(0);
  await sendSetupInvitation({ data: { ...attempt, attemptId: crypto.randomUUID(), previousAttemptId: attempt.attemptId } });
  expect(auth.sends).toBe(1); expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});
it("refuses an explicit resend after the invitation was revoked", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); auth.delivery = "reject"; const attempt = f.attempt();
  const result = await sendSetupInvitation({ data: attempt });
  await getPrisma().invitation.update({ where: { id: result.invitations[0]!.invitationId! }, data: { status: "canceled" } });
  await expect(sendSetupInvitation({ data: { ...attempt, attemptId: crypto.randomUUID(), previousAttemptId: attempt.attemptId } })).rejects.toThrow("review in Team");
  expect(auth.sends).toBe(1); expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("can explicitly resend a stale interrupted attempt without creating another invitation", async () => {
  const f = await fixture(); await saveSetupTeam({ data: f.input }); auth.delivery = "reject";
  const old = f.attempt(); const first = await sendSetupInvitation({ data: old });
  const invitation = first.invitations[0]?.invitationId; expect(invitation).toBeTruthy();
  await env.DB.prepare("UPDATE app_setting SET value=json_set(value,'$.state','running','$.occurredAt',0) WHERE orgId=? AND key=?")
    .bind(f.orgId, `onboarding-invite:${f.input.batchId}:0`).run();
  auth.delivery = "accept";
  const retry = { ...old, attemptId: crypto.randomUUID(), previousAttemptId: old.attemptId };
  const result = await sendSetupInvitation({ data: retry }); expect(result.invitations[0]).toMatchObject({ state: "accepted", invitationId: invitation });
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1); expect(auth.sends).toBe(2);
  await recordSetupInvitation(env.DB, old, "failed", invitation ?? null);
  expect((await getSetupTeam({ data: { orgId: f.orgId } })).invitations[0]?.state).toBe("accepted");
});
