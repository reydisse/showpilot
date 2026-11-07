import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { addMicAssignment, updateMicAssignment, deleteMicAssignment, getMicAssignments } from "../data";

const request = vi.hoisted(() => ({ cookie: "" }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; },
      handler: (fn: (input: unknown) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
afterEach(() => { request.cookie = ""; });

async function fixture() {
  const prisma = getPrisma(); const userId = crypto.randomUUID(); const orgId = crypto.randomUUID();
  const email = `${userId}@example.test`; const password = "Audio-fixture-password-92!";
  await prisma.user.create({ data: { id: userId, name: "Audio operator", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Audio fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${Math.floor(Math.random()*200)+1}` },
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const showId = crypto.randomUUID();
  await prisma.rundown.create({ data: { id: showId, orgId, serviceDate: "2026-11-07", name: "Audio show" } });
  const input = { orgId, showId, serviceDate: "2026-11-07", channel: 1, label: "Lectern", micType: "wired" };
  return { prisma, orgId, userId, input };
}

// Authenticate through the real endpoint before timing each mutation test.
// Cold Worker/auth startup has its own hook deadline; writes keep Vitest's 5s limit.
let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { authenticated = await fixture(); });

it("concurrent retries create one channel and one receipt", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  const [first, second] = await Promise.all([addMicAssignment({ data }), addMicAssignment({ data })]);
  expect(first.id).toBe(second.id);
  expect(await f.prisma.micAssignment.count({ where: { orgId: f.orgId } })).toBe(1);
  expect((await env.DB.prepare("SELECT count(*) n FROM audio_write_receipt WHERE orgId=?").bind(f.orgId).first<{n:number}>())?.n).toBe(1);
  await expect(addMicAssignment({ data: { ...data, label: "Different" } })).rejects.toThrow("different channel changes");
  expect((await getMicAssignments({ data: f.input }))[0].label).toBe("Lectern");
});
it("replaying an update never overwrites a later edit", async () => {
  const f = authenticated; const row = await addMicAssignment({ data: f.input });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { muted: true, notes: "First" } };
  await updateMicAssignment({ data });
  await updateMicAssignment({ data: { orgId: f.orgId, id: row.id, updates: { muted: false, notes: "Later" } } });
  await updateMicAssignment({ data });
  expect(await f.prisma.micAssignment.findUnique({ where: { id: row.id } })).toMatchObject({ muted: false, notes: "Later" });
  await expect(updateMicAssignment({ data: { ...data, updates: { muted: false } } })).rejects.toThrow("different channel changes");
});
it("delete replay succeeds without recreating a removed channel", async () => {
  const f = authenticated; const creation = { ...f.input, requestId: crypto.randomUUID() };
  const row = await addMicAssignment({ data: creation });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID() };
  await deleteMicAssignment({ data }); await deleteMicAssignment({ data });
  await expect(addMicAssignment({ data: creation })).rejects.toThrow("will not recreate");
  expect(await f.prisma.micAssignment.count({ where: { orgId: f.orgId } })).toBe(0);
});
it("rolls back the receipt with a rejected mutation, then retries the same command", async () => {
  const f = authenticated; const row = await addMicAssignment({ data: f.input });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { label: "Saved after retry", muted: true } };
  await env.DB.prepare(`CREATE TRIGGER fixture_audio_failure BEFORE UPDATE ON mic_assignment WHEN NEW.orgId='${f.orgId}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`).run();
  try {
    await expect(updateMicAssignment({ data })).rejects.toThrow("could not be confirmed");
    expect(await f.prisma.micAssignment.findUnique({ where: { id: row.id } })).toMatchObject({ label: "Lectern", muted: false });
    expect(await env.DB.prepare("SELECT requestId FROM audio_write_receipt WHERE orgId=? AND requestId=?").bind(f.orgId,data.requestId).first()).toBeNull();
  } finally { await env.DB.exec("DROP TRIGGER fixture_audio_failure"); }
  await updateMicAssignment({ data });
  expect(await f.prisma.micAssignment.findUnique({ where: { id: row.id } })).toMatchObject({ label: "Saved after retry", muted: true });
});
it("rejects foreign or date-mismatched shows before committing a receipt", async () => {
  const f = authenticated; const otherOrg = crypto.randomUUID();
  await f.prisma.organization.create({ data: { id: otherOrg, slug: otherOrg, name: "Other", createdAt: new Date() } });
  await f.prisma.rundown.create({ data: { id: "foreign-audio-show", orgId: otherOrg, serviceDate: f.input.serviceDate } });
  await expect(addMicAssignment({ data: { ...f.input, showId: "foreign-audio-show" } })).rejects.toThrow("no longer available");
  await expect(addMicAssignment({ data: { ...f.input, serviceDate: "2026-11-08" } })).rejects.toThrow("no longer available");
  expect(await f.prisma.micAssignment.count({ where: { orgId: f.orgId } })).toBe(0);
  expect(await env.DB.prepare("SELECT requestId FROM audio_write_receipt WHERE orgId=?").bind(f.orgId).first()).toBeNull();
});
it("cannot update or remove another organization's channel", async () => {
  const f = authenticated; const otherOrg = crypto.randomUUID();
  await f.prisma.organization.create({ data: { id: otherOrg, slug: otherOrg, name: "Other", createdAt: new Date() } });
  const row = await f.prisma.micAssignment.create({ data: { ...f.input, orgId: otherOrg, showId: null } });
  await expect(updateMicAssignment({ data: { orgId: f.orgId, id: row.id, updates: { label: "Changed" } } })).rejects.toThrow("no longer available");
  await expect(deleteMicAssignment({ data: { orgId: f.orgId, id: row.id } })).rejects.toThrow("no longer available");
  expect(await f.prisma.micAssignment.findUnique({ where: { id: row.id } })).toMatchObject({ label: "Lectern" });
});
it("rechecks membership before replaying an acknowledged creation", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  await addMicAssignment({ data });
  await f.prisma.member.deleteMany({ where: { organizationId: f.orgId, userId: f.userId } });
  await expect(addMicAssignment({ data })).rejects.toThrow("Forbidden");
});
it("binds channel text and strips unknown update fields", async () => {
  const f = authenticated; const row = await addMicAssignment({ data: f.input });
  const updates = { label: `Lectern's \"mic\"; DROP TABLE mic_assignment; --`, orgId: "not-an-org", id: "not-a-channel" };
  await updateMicAssignment({ data: { orgId: f.orgId, id: row.id, updates } });
  expect(await f.prisma.micAssignment.findUnique({ where: { id: row.id } })).toMatchObject({ orgId: f.orgId, label: updates.label });
});
