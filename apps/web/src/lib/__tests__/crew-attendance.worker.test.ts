import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { applyCrewAttendance } from "../crew-attendance.server";
import { attendanceMember, readAttendanceRows } from "../attendance-state.server";
import { applyPublicAttendanceIntent, getPublicAttendanceMember } from "../public-checkin.server";
import { crewAttendanceWriteSchema, type CrewAttendanceWrite } from "../crew-attendance-writes";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => auth.userId ? { user: { id: auth.userId, name: "Operator", email: "operator@example.test" } } : null } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { changeCrewAttendance, getCheckInMembers } from "../crew-attendance";
async function fixture(count = 3) {
  const { orgId, userId } = await seedRelayMember(`crew-attendance-${crypto.randomUUID()}`); auth.userId = userId;
  const ids = Array.from({ length: count }, (_, i) => `${orgId}-${i}`);
  await env.DB.prepare(`INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline)
    SELECT json_extract(value,'$.id'),?,json_extract(value,'$.memberId'),json_extract(value,'$.name'),'Crew','','',0 FROM json_each(?)`)
    .bind(orgId, JSON.stringify(ids.map((id, i) => ({ id, memberId: `CREW${i}`, name: `Crew ${i}` })))).run();
  const read = async () => Promise.all((await readAttendanceRows(env.DB, orgId)).map(attendanceMember));
  const request = async (isOnline: boolean, selection = ids): Promise<CrewAttendanceWrite> => ({ orgId, requestId: crypto.randomUUID(), isOnline,
    members: (await read()).filter(member => selection.includes(member.id)).map(member => ({ id: member.id, expectedRevision: member.revision })) });
  const save = (input: CrewAttendanceWrite) => applyCrewAttendance(env.DB, input, userId);
  return { orgId, userId, ids, read, request, save };
}
const timestamps = async (orgId: string) => (await env.DB.prepare("SELECT id,lastCheckIn,lastCheckOut FROM crew_member WHERE orgId=? ORDER BY id").bind(orgId).all()).results;
it("replays a bulk acknowledgement without reversing a later change or its timestamps", async () => {
  const f = await fixture(); const bulk = await f.request(true);
  expect(await f.save(bulk)).toMatchObject({ outcome: "applied", changedCount: 3 });
  await f.save(await f.request(false, [f.ids[0]])); const times = await timestamps(f.orgId);
  expect(await f.save(bulk)).toMatchObject({ outcome: "applied", changedCount: 3 });
  expect((await f.read()).filter(member => member.isOnline)).toHaveLength(2); expect(await timestamps(f.orgId)).toEqual(times);
});
it("rejects the whole captured bulk selection when one member changes, without a partial save", async () => {
  const f = await fixture(); const bulk = await f.request(true);
  await f.save(await f.request(true, [f.ids[0]]));
  expect(await f.save(bulk)).toMatchObject({ outcome: "conflict", changedCount: 0 });
  expect((await f.read()).filter(member => member.isOnline)).toHaveLength(1);
  await f.save(await f.request(false, [f.ids[0]]));
  expect((await f.save(bulk)).outcome).toBe("conflict");
  expect((await f.read()).filter(member => member.isOnline)).toHaveLength(0);
});
it("includes only the crew captured by the bulk confirmation", async () => {
  const f = await fixture(1); const input = await f.request(true);
  await env.DB.prepare("INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES (?,?,?,'New arrival','Crew','','',0)").bind(`${f.orgId}-new`, f.orgId, "NEW").run();
  expect((await f.save(input)).outcome).toBe("applied");
  expect((await f.read()).find(member => member.memberId === "NEW")?.isOnline).toBe(false);
});
it("deduplicates concurrent identical delivery and rejects a competing request against the old revision", async () => {
  const f = await fixture(1); const input = await f.request(true);
  const duplicate = await Promise.all([f.save(input), f.save(input), f.save(input)]);
  expect(duplicate.every(result => result.outcome === "applied")).toBe(true);
  expect((await f.save({ ...input, requestId: crypto.randomUUID() })).outcome).toBe("conflict");
  expect(await env.DB.prepare("SELECT count(*) AS count FROM app_setting WHERE orgId=? AND key LIKE 'attendance-write:%'").bind(f.orgId).first<number>("count")).toBe(2);
});
it("preserves existing timestamps when attendance already matches the requested intent", async () => {
  const f = await fixture(); await f.save(await f.request(true)); const times = await timestamps(f.orgId);
  expect(await f.save(await f.request(true))).toMatchObject({ outcome: "applied", changedCount: 0 });
  expect(await timestamps(f.orgId)).toEqual(times);
});
it("rejects a captured identity that was deleted and replaced", async () => {
  const f = await fixture(1); const input = await f.request(true);
  await env.DB.prepare("DELETE FROM crew_member WHERE id=? AND orgId=?").bind(f.ids[0], f.orgId).run();
  await env.DB.prepare("INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES (?,?,?,'Replacement','Crew','','',0)").bind(`${f.orgId}-replacement`, f.orgId, "CREW0").run();
  expect((await f.save(input)).outcome).toBe("conflict"); expect((await f.read())[0].isOnline).toBe(false);
});
it("binds receipts to actor and full intent while allowing reordered identical selections", async () => {
  const f = await fixture(); const input = await f.request(true); await f.save(input);
  expect((await f.save({ ...input, members: [...input.members].reverse() })).outcome).toBe("applied");
  await expect(f.save({ ...input, isOnline: false })).rejects.toThrow("different attendance change");
  await expect(f.save({ ...input, members: input.members.slice(1) })).rejects.toThrow("different attendance change");
  await expect(applyCrewAttendance(env.DB, input, "different-operator")).rejects.toThrow("different attendance change");
});
it("bounds SQL parameters for 250 crew and rejects duplicate targets at the API boundary", async () => {
  const f = await fixture(250); const input = await f.request(true);
  expect((await f.save(input)).changedCount).toBe(250); expect((await f.read()).every(member => member.isOnline)).toBe(true);
  expect(crewAttendanceWriteSchema.safeParse({ ...input, members: [input.members[0], input.members[0]] }).success).toBe(false);
  expect(crewAttendanceWriteSchema.safeParse({ ...input, members: [] }).success).toBe(false);
});
it("does not update foreign crew even when a request mixes organizations", async () => {
  const a = await fixture(1), b = await fixture(1); const first = await a.request(true), other = await b.request(true);
  expect((await a.save({ ...first, members: [...first.members, ...other.members] })).outcome).toBe("conflict");
  expect((await a.read())[0].isOnline).toBe(false); expect((await b.read())[0].isOnline).toBe(false);
  expect((await b.save({ ...other, requestId: first.requestId })).outcome).toBe("applied");
});
it("rechecks operator access on reads, writes and receipt replays", async () => {
  const f = await fixture(1); const input = await f.request(true);
  expect((await changeCrewAttendance({ data: input })).outcome).toBe("applied");
  const members = await getCheckInMembers({ data: { orgId: f.orgId } });
  expect(Object.keys(members[0]).sort()).toEqual(["id", "isOnline", "memberId", "name", "photoUrl", "revision", "role"]);
  auth.userId = ""; await expect(changeCrewAttendance({ data: input })).rejects.toThrow("Unauthorized");
  await expect(getCheckInMembers({ data: { orgId: f.orgId } })).rejects.toThrow("Unauthorized");
  auth.userId = f.userId;
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId, f.userId).run();
  await expect(changeCrewAttendance({ data: input })).rejects.toThrow("Forbidden");
  await expect(getCheckInMembers({ data: { orgId: f.orgId } })).rejects.toThrow("Forbidden");
});
it("shares revision checks with public kiosk changes without changing the public receipt contract", async () => {
  const f = await fixture(1); const input = await f.request(true); const member = await getPublicAttendanceMember(env.DB, f.orgId, "CREW0");
  if (!member) throw new Error("Fixture missing");
  const publicInput = { slug: f.orgId, memberId: "CREW0", intent: "check-in" as const, expectedRevision: member.revision, requestId: crypto.randomUUID() };
  await applyPublicAttendanceIntent(env.DB, f.orgId, publicInput);
  expect((await f.save(input)).outcome).toBe("conflict");
  await f.save(await f.request(false));
  expect(await applyPublicAttendanceIntent(env.DB, f.orgId, publicInput)).toMatchObject({ outcome: "applied", member: { isOnline: false } });
});
it("rolls back all crew changes and the receipt when the transaction fails", async () => {
  const f = await fixture(); const input = await f.request(true);
  const failing = { prepare: env.DB.prepare.bind(env.DB), batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>([...statements,
    env.DB.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES (?,'duplicate',?,CURRENT_TIMESTAMP)").bind(f.orgId, f.orgId),
  ]) };
  await expect(applyCrewAttendance(failing, input, f.userId)).rejects.toThrow();
  expect((await f.read()).every(member => !member.isOnline)).toBe(true);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM app_setting WHERE orgId=? AND key LIKE 'attendance-write:%'").bind(f.orgId).first<number>("count")).toBe(0);
});
