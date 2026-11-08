import { nextFixtureAddress } from "@/test/fixture-address";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { addDevice, updateDevice, deleteDevice, getDevices } from "../data";

import { runDeviceWrite } from "../device-write.server";
import { CredentialVault } from "../credential-vault.server";
import { readDeviceSettingsForUse } from "../device-settings.server";
import { CREDENTIAL_MASK } from "../credential-fields";

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
const authSecret = env.BETTER_AUTH_SECRET;
afterEach(() => { request.cookie = ""; env.BETTER_AUTH_SECRET = authSecret; vi.restoreAllMocks(); });

async function fixture() {
  const prisma = getPrisma(); const userId = crypto.randomUUID(); const orgId = crypto.randomUUID();
  const email = `${userId}@example.test`; const password = "Device-fixture-password-92!";
  await prisma.user.create({ data: { id: userId, name: "Device operator", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Device fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const input = { orgId, name: "Fixture OBS", category: "streaming", adapterType: "obs", settings: JSON.stringify({ host: "127.0.0.1", password: "fixture-password" }), enabled: false };
  return { prisma, orgId, userId, input };
}
async function stored(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const row = await f.prisma.device.findFirstOrThrow({ where: { orgId: f.orgId, id } });
  return { row, settings: await readDeviceSettingsForUse(env.CREDENTIAL_ENCRYPTION_KEYS, row) };
}

it("concurrent creation retries share one device at the free-plan cap", async () => {
  const f = await fixture(); await addDevice({ data: { ...f.input, name: "First" } });
  const data = { ...f.input, requestId: crypto.randomUUID() };
  const [one,two] = await Promise.all([addDevice({ data }),addDevice({ data })]);
  expect(one.id).toBe(two.id); expect(one.settings).toContain(CREDENTIAL_MASK);
  expect(await f.prisma.device.count({ where: { orgId: f.orgId } })).toBe(2);
  expect((await addDevice({ data })).id).toBe(one.id);
  await expect(addDevice({ data: f.input })).rejects.toThrow("allows up to 2");
});
it("rejects changed credential requests and stores no plain secret or payload digest", async () => {
  const f = await fixture(); const data = { ...f.input, requestId: crypto.randomUUID() };
  const row = await addDevice({ data });
  await expect(addDevice({ data: { ...data, settings: JSON.stringify({ password: "changed-password" }) } })).rejects.toThrow("different device changes");
  const receipt = await env.DB.prepare("SELECT * FROM device_write_receipt WHERE orgId=?").bind(f.orgId).first<{ fingerprint: string }>();
  expect(receipt?.fingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(receipt)).not.toContain("fixture-password");
  expect((await stored(f,row.id)).row.settings).not.toContain("fixture-password");
  env.BETTER_AUTH_SECRET = "rotated-auth-secret-for-fixture-only-12345";
  await expect(addDevice({ data })).rejects.toThrow("Unauthorized");
  await expect(runDeviceWrite({ orgId: f.orgId, actorId: f.userId, requestId: data.requestId, kind: "create", payload: f.input }, () => { throw new Error("A receipt must never be planned again"); })).rejects.toThrow("different device changes");
  expect(await f.prisma.device.count({ where: { orgId: f.orgId } })).toBe(1);
});
it("a replay never restores replaced or explicitly cleared credentials", async () => {
  const f = await fixture(); const row = await addDevice({ data: f.input });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { settings: JSON.stringify({ password: "replacement" }) } };
  await updateDevice({ data });
  const clear = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: {}, clearCredentials: [["password"]] };
  await updateDevice({ data: clear }); await updateDevice({ data });
  expect((await stored(f,row.id)).settings.password).toBe("");
  await updateDevice({ data: { orgId: f.orgId, id: row.id, updates: { settings: JSON.stringify({ password: "newer" }), enabled: true } } });
  await updateDevice({ data: clear });
  expect((await stored(f,row.id)).settings.password).toBe("newer");
  expect((await stored(f,row.id)).row.enabled).toBe(true);
});
it("a retained toggle request cannot undo a later state", async () => {
  const f = await fixture(); const row = await addDevice({ data: f.input });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { enabled: true } };
  await updateDevice({ data });
  await updateDevice({ data: { orgId: f.orgId, id: row.id, updates: { enabled: false } } });
  await updateDevice({ data });
  expect((await stored(f,row.id)).row.enabled).toBe(false);
});
it("delete replay succeeds and creation replay cannot resurrect the removed device", async () => {
  const f = await fixture(); const creation = { ...f.input, requestId: crypto.randomUUID() };
  const row = await addDevice({ data: creation });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID() };
  await deleteDevice({ data }); await deleteDevice({ data });
  await expect(addDevice({ data: creation })).rejects.toThrow("will not recreate");
  expect(await getDevices({ data: { orgId: f.orgId } })).toEqual([]);
});
it("rolls back the receipt and encrypted update when the mutation fails", async () => {
  const f = await fixture(); const row = await addDevice({ data: f.input });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { name: "Renamed", settings: JSON.stringify({ password: "after-retry" }) } };
  await env.DB.prepare(`CREATE TRIGGER fixture_device_failure BEFORE UPDATE ON device WHEN NEW.orgId='${f.orgId}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`).run();
  try {
    await expect(updateDevice({ data })).rejects.toThrow("could not be confirmed");
    expect((await stored(f,row.id)).settings.password).toBe("fixture-password");
    expect(await env.DB.prepare("SELECT requestId FROM device_write_receipt WHERE orgId=? AND requestId=?").bind(f.orgId,data.requestId).first()).toBeNull();
  } finally { await env.DB.exec("DROP TRIGGER fixture_device_failure"); }
  await updateDevice({ data });
  expect((await stored(f,row.id)).settings.password).toBe("after-retry");
  expect((await stored(f,row.id)).row.name).toBe("Renamed");
});
it("keeps the existing compare-and-set guard while encrypting new settings", async () => {
  const f = await fixture(); const row = await addDevice({ data: f.input });
  const encrypt = CredentialVault.prototype.encrypt;
  vi.spyOn(CredentialVault.prototype,"encrypt").mockImplementationOnce(async function(this: CredentialVault,scope,plaintext) {
    await env.DB.prepare("UPDATE device SET name=?,updatedAt=? WHERE id=? AND orgId=?").bind("Concurrent edit","2030-01-01T00:00:00.000Z",row.id,f.orgId).run();
    return encrypt.call(this,scope,plaintext);
  });
  const data = { orgId: f.orgId, id: row.id, requestId: crypto.randomUUID(), updates: { name: "Stale edit", settings: JSON.stringify({ password: "stale-secret" }) } };
  await expect(updateDevice({ data })).rejects.toThrow("Device changed elsewhere");
  const latest = await stored(f,row.id);
  expect(latest.row.name).toBe("Concurrent edit");expect(latest.settings.password).toBe("fixture-password");
  expect(await env.DB.prepare("SELECT requestId FROM device_write_receipt WHERE orgId=? AND requestId=?").bind(f.orgId,data.requestId).first()).toBeNull();
});
it("rejects another organization's row and rechecks membership on replay", async () => {
  const f = await fixture(); const mine = { ...f.input, requestId: crypto.randomUUID() };
  await addDevice({ data: mine });
  const other = crypto.randomUUID(); await f.prisma.organization.create({ data: { id: other,slug: other,name: "Other",createdAt: new Date() } });
  const row = await f.prisma.device.create({ data: { orgId: other,name: "Foreign",category: "video" } });
  await expect(updateDevice({ data: { orgId: f.orgId,id: row.id,updates: { name: "Changed" } } })).rejects.toThrow("Device not found");
  await expect(deleteDevice({ data: { orgId: f.orgId,id: row.id } })).rejects.toThrow("Device changed elsewhere");
  expect((await f.prisma.device.findUniqueOrThrow({ where: { id: row.id } })).name).toBe("Foreign");
  await f.prisma.member.deleteMany({ where: { organizationId: f.orgId,userId: f.userId } });
  await expect(addDevice({ data: mine })).rejects.toThrow("Forbidden");
});
