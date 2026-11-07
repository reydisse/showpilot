import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { getPrisma } from "../db";
import { seedRelayMember } from "@/test/relay-fixtures";
import { applyPublicAttendanceIntent, getPublicAttendanceMember } from "../public-checkin.server";
import type { PublicAttendanceWrite } from "../public-checkin";
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ "cf-connecting-ip": "192.0.2.1" }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { getPublicCheckInOrg, getPublicCrewMemberByMemberId, publicCheckInByMemberId } from "../data";
async function fixture() {
  const { orgId } = await seedRelayMember(`attendance-${crypto.randomUUID()}`);
  const id = crypto.randomUUID(), memberId = "TD3917";
  await env.DB.prepare("INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES (?,?,?,'Fixture person','Director','','',0)").bind(id, orgId, memberId).run();
  const read = () => getPublicAttendanceMember(env.DB, orgId, memberId);
  const request = async (intent: "check-in" | "check-out"): Promise<PublicAttendanceWrite> => {
    const member = await read(); if (!member) throw new Error("Fixture member missing");
    return { slug: orgId, memberId, intent, expectedRevision: member.revision, requestId: crypto.randomUUID() };
  };
  return { orgId, id, memberId, read, request, save: (input: PublicAttendanceWrite) => applyPublicAttendanceIntent(env.DB, orgId, input) };
}
const timestamps = (orgId: string) => env.DB.prepare("SELECT lastCheckIn,lastCheckOut FROM crew_member WHERE orgId=?").bind(orgId).first();

it("replays an acknowledged check-in without undoing a later check-out or changing its timestamps", async () => {
  const f = await fixture(); const first = await f.request("check-in");
  expect((await f.save(first)).member?.isOnline).toBe(true);
  const firstTimes = await timestamps(f.orgId);
  expect((await f.save(first)).outcome).toBe("applied"); expect(await timestamps(f.orgId)).toEqual(firstTimes);
  await f.save(await f.request("check-out")); const finalTimes = await timestamps(f.orgId);
  expect(await f.save(first)).toMatchObject({ outcome: "applied", member: { isOnline: false } });
  expect(await timestamps(f.orgId)).toEqual(finalTimes);
});
it("prevents an old check-out from reversing a later check-in", async () => {
  const f = await fixture(); await f.save(await f.request("check-in"));
  const old = await f.request("check-out"); await f.save(old); await f.save(await f.request("check-in"));
  const finalTimes = await timestamps(f.orgId);
  expect(await f.save(old)).toMatchObject({ outcome: "applied", member: { isOnline: true } });
  expect(await timestamps(f.orgId)).toEqual(finalTimes);
});
it("deduplicates concurrent delivery and rejects a competing stale lookup", async () => {
  const f = await fixture(); const input = await f.request("check-in");
  const duplicate = await Promise.all([f.save(input), f.save(input), f.save(input)]);
  expect(duplicate.every(result => result.outcome === "applied")).toBe(true);
  expect((await f.save({ ...input, requestId: crypto.randomUUID() })).outcome).toBe("conflict");
  expect(await env.DB.prepare("SELECT count(*) AS count FROM app_setting WHERE orgId=? AND key LIKE 'public-attendance:%'").bind(f.orgId).first<number>("count")).toBe(2);
});
it("rejects a stale lookup after an out-and-back attendance change", async () => {
  const f = await fixture(); const stale = await f.request("check-in");
  await f.save(await f.request("check-in")); await f.save(await f.request("check-out"));
  expect((await f.read())?.isOnline).toBe(false);
  expect((await f.save(stale)).outcome).toBe("conflict");
  expect((await f.read())?.isOnline).toBe(false);
  expect((await f.save(stale)).outcome).toBe("conflict");
});
it("does not treat a re-created member with the same printed ID as the original person", async () => {
  const f = await fixture(); const old = await f.request("check-in");
  await env.DB.prepare("DELETE FROM crew_member WHERE id=?").bind(f.id).run();
  await env.DB.prepare("INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES (?,?,?,'Replacement','Crew','','',0)").bind(crypto.randomUUID(), f.orgId, f.memberId).run();
  expect((await f.save(old)).outcome).toBe("conflict"); expect((await f.read())?.isOnline).toBe(false);
});
it("binds a receipt to the ID, intent and lookup revision", async () => {
  const f = await fixture(); const input = await f.request("check-in"); await f.save(input);
  for (const changed of [{ ...input, memberId: "OTHER" }, { ...input, intent: "check-out" as const }, { ...input, expectedRevision: "0".repeat(64) }]) {
    await expect(f.save(changed)).rejects.toThrow("different attendance change");
  }
  expect((await f.read())?.isOnline).toBe(true);
});
it("scopes receipts and crew lookup to the organization", async () => {
  const a = await fixture(), b = await fixture(); const input = await a.request("check-in"); await a.save(input);
  expect((await b.save({ ...await b.request("check-in"), requestId: input.requestId })).outcome).toBe("applied");
  expect(await getPublicAttendanceMember(env.DB, "missing", a.memberId)).toBeNull();
  expect((await b.save(await a.request("check-out"))).outcome).toBe("conflict");
  expect((await b.read())?.isOnline).toBe(true);
});
it("records a conflict when a member disappears and does not recreate attendance", async () => {
  const f = await fixture(); const input = await f.request("check-in");
  await env.DB.prepare("DELETE FROM crew_member WHERE id=?").bind(f.id).run();
  expect(await f.save(input)).toMatchObject({ outcome: "conflict", member: null });
  expect(await f.read()).toBeNull();
});
it("rolls back the receipt with the attendance change if the transaction fails", async () => {
  const f = await fixture(); const input = await f.request("check-in");
  const failing = { prepare: env.DB.prepare.bind(env.DB), batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>([...statements,
    env.DB.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES (?,'duplicate',?,CURRENT_TIMESTAMP)").bind(f.orgId, f.orgId),
  ]) };
  await expect(applyPublicAttendanceIntent(failing, f.orgId, input)).rejects.toThrow();
  expect((await f.read())?.isOnline).toBe(false);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM app_setting WHERE orgId=? AND key LIKE 'public-attendance:%'").bind(f.orgId).first<number>("count")).toBe(0);
  expect((await f.save(input)).outcome).toBe("applied");
});
it("validates public RPCs, returns only public member fields, and retains per-ID rate limiting", async () => {
  const f = await fixture();
  expect(await getPublicCheckInOrg({ data: { slug: "missing" } })).toBeNull();
  const member = await getPublicCrewMemberByMemberId({ data: { slug: f.orgId, memberId: " td3917 " } });
  expect(Object.keys(member ?? {}).sort()).toEqual(["isOnline", "memberId", "name", "photoUrl", "revision", "role"]);
  await expect(publicCheckInByMemberId({ data: { slug: f.orgId, memberId: f.memberId, intent: "check-in" } })).rejects.toThrow();
  const input = await f.request("check-in");
  for (let n = 0; n < 6; n++) expect((await publicCheckInByMemberId({ data: input })).outcome).toBe("applied");
  await expect(publicCheckInByMemberId({ data: input })).rejects.toThrow("Too many attempts for this member ID");
  expect((await f.read())?.isOnline).toBe(true);
});


it("keeps attendance timestamps readable by existing Prisma operator screens", async () => {
  const f = await fixture(); await f.save(await f.request("check-in"));
  const member = await getPrisma().crewMember.findUnique({ where: { orgId_memberId: { orgId: f.orgId, memberId: f.memberId } } });
  expect(member?.isOnline).toBe(true);
  expect(member?.lastCheckIn).toBeInstanceOf(Date);
  expect(member?.lastCheckIn?.getTime()).toBeGreaterThan(0);
  await f.save(await f.request("check-out"));
  const updated = await getPrisma().crewMember.findUnique({ where: { orgId_memberId: { orgId: f.orgId, memberId: f.memberId } } });
  expect(updated?.isOnline).toBe(false);
  expect(updated?.lastCheckOut?.getTime()).toBeGreaterThan(member?.lastCheckIn?.getTime() ?? 0);
});
