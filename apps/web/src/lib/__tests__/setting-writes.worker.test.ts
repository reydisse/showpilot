import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { updateOrgSetting, getManageableOrgSettings } from "../settings";
import { applySettingWrite } from "../setting-writes.server";
import type { SettingWrite } from "../setting-writes";
async function fixture() {
  const member = await seedRelayMember(`setting-writes-${crypto.randomUUID()}`);
  auth.userId = member.userId;
  await env.DB.prepare("UPDATE organization SET plan='pro' WHERE id=?").bind(member.orgId).run();
  return member;
}
function change(orgId: string, value: string, expectedValue: string | null = null): SettingWrite {
  return { orgId, key: "org-timezone", value, expectedValue, requestId: crypto.randomUUID() };
}
const save = (data: SettingWrite) => updateOrgSetting({ data });
const stored = (orgId: string, key = "org-timezone") => env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?").bind(orgId, key).first<string>("value");

it("commits a receipt and value once and never replays an old save over a later edit", async () => {
  const { orgId } = await fixture(); const first = change(orgId, "UTC");
  expect(await save(first)).toMatchObject({ outcome: "applied", currentValue: "UTC", requestId: first.requestId });
  await save(change(orgId, "America/Toronto", "UTC"));
  expect(await save(first)).toMatchObject({ outcome: "applied", currentValue: "America/Toronto" });
  expect(await stored(orgId)).toBe("America/Toronto");
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_setting WHERE orgId=? AND key LIKE 'setting-write:%'").bind(orgId).first<number>("count")).toBe(2);
  expect(await getManageableOrgSettings({ data: { orgId } })).toEqual({ "org-timezone": "America/Toronto" });
});

it("serializes duplicate concurrent delivery without duplicate receipts", async () => {
  const { orgId, userId } = await fixture(); const input = change(orgId, "UTC");
  const results = await Promise.all([applySettingWrite(env.DB, input, userId), applySettingWrite(env.DB, input, userId), applySettingWrite(env.DB, input, userId)]);
  expect(results.every(result => result.outcome === "applied")).toBe(true);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_setting WHERE orgId=?").bind(orgId).first<number>("count")).toBe(2);
});

it("allows only one competing edit against the same prior value", async () => {
  const { orgId, userId } = await fixture();
  const results = await Promise.all([applySettingWrite(env.DB, change(orgId, "UTC"), userId), applySettingWrite(env.DB, change(orgId, "America/Toronto"), userId)]);
  expect(results.map(result => result.outcome).sort()).toEqual(["applied", "conflict"]);
  const winner = results.find(result => result.outcome === "applied");
  expect(await stored(orgId)).toBe(winner?.currentValue);
});

it("keeps a conflict receipt rejected even if the saved value later matches its original baseline", async () => {
  const { orgId } = await fixture(); await save(change(orgId, "UTC"));
  const stale = change(orgId, "Europe/London", "old");
  expect((await save(stale)).outcome).toBe("conflict");
  await save(change(orgId, "old", "UTC"));
  expect(await save(stale)).toMatchObject({ outcome: "conflict", currentValue: "old" });
  expect(await stored(orgId)).toBe("old");
  expect((await save(change(orgId, "Europe/London", "old"))).outcome).toBe("applied");
});

it("binds a request ID to its payload and actor", async () => {
  const { orgId } = await fixture(); const input = change(orgId, "UTC"); await save(input);
  await expect(save({ ...input, value: "changed" })).rejects.toThrow("different setting change");
  const second = await seedRelayMember(orgId, `second-${crypto.randomUUID()}`); auth.userId = second.userId;
  await expect(save(input)).rejects.toThrow("different setting change");
  expect(await stored(orgId)).toBe("UTC");
});

it("checks current membership on Retry before reading a committed receipt", async () => {
  const { orgId, userId } = await fixture(); const input = change(orgId, "UTC"); await save(input);
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  await expect(save(input)).rejects.toThrow("Forbidden");
  expect(await stored(orgId)).toBe("UTC");
});

it("rejects cross-org requests and scopes identical request IDs independently", async () => {
  const first = await fixture(), second = await fixture(); const input = change(first.orgId, "UTC");
  await expect(save(input)).rejects.toThrow("Forbidden");
  auth.userId = first.userId; await save(input);
  auth.userId = second.userId;
  expect((await save({ ...input, orgId: second.orgId, value: "America/Toronto" })).outcome).toBe("applied");
  expect(await stored(first.orgId)).toBe("UTC"); expect(await stored(second.orgId)).toBe("America/Toronto");
});

it("rejects invalid layouts, credential writes and old unconditional payloads before storage", async () => {
  const { orgId } = await fixture();
  await expect(save({ ...change(orgId, "{}"), key: "default-confidence-layout" })).rejects.toThrow();
  await expect(save({ ...change(orgId, "private"), key: "propresenter-password" })).rejects.toThrow("dedicated credential editor");
  await expect(updateOrgSetting({ data: { orgId, key: "org-timezone", value: "UTC" } })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM app_setting WHERE orgId=?").bind(orgId).first<number>("count")).toBe(0);
});

it("distinguishes an absent field from an empty saved value", async () => {
  const { orgId } = await fixture(); await save(change(orgId, ""));
  expect((await save(change(orgId, "UTC"))).outcome).toBe("conflict");
  expect((await save(change(orgId, "UTC", ""))).outcome).toBe("applied");
});

it("rolls back both receipt and setting if the transaction fails", async () => {
  const { orgId, userId } = await fixture(); const input = change(orgId, "UTC");
  const failing = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>([...statements,
      env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'duplicate',?,CURRENT_TIMESTAMP)").bind(orgId, orgId),
    ]),
  };
  await expect(applySettingWrite(failing, input, userId)).rejects.toThrow();
  expect(await stored(orgId)).toBeNull();
  expect(await stored(orgId, `setting-write:${input.requestId}`)).toBeNull();
  expect((await save(input)).outcome).toBe("applied");
});
