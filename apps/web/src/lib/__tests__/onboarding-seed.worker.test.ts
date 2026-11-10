import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { getOnboardingProgress, getOnboardingSeed, seedOrgTemplate } from "../onboarding";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: auth.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => { let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-setup-password-92!";
  await getPrisma().account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${++auth.ip}` }, body: JSON.stringify({ email: `${userId}@example.test`, password }) }));
  expect(login.status).toBe(200); await login.arrayBuffer(); auth.cookie = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { orgId, userId };
}
it("rolls back the whole template when a checklist insert fails", async () => {
  const { orgId } = await fixture();
  await env.DB.prepare(`CREATE TRIGGER fail_setup_checklist BEFORE INSERT ON checklist_template WHEN NEW.orgId = '${orgId}' BEGIN SELECT RAISE(ABORT, 'Fixture checklist failure'); END`).run();
  try {
    await expect(seedOrgTemplate({ data: { orgId, template: "sunday", serviceDate: "2026-11-07" } })).rejects.toThrow();
    expect(await getPrisma().rundown.count({ where: { orgId } })).toBe(0);
    expect(await getPrisma().rundownItem.count({ where: { orgId } })).toBe(0);
  } finally { await env.DB.prepare("DROP TRIGGER fail_setup_checklist").run(); }
});

const date = "2026-11-07";
const seed = (orgId: string, template = "sunday", serviceDate = date) => seedOrgTemplate({ data: { orgId, template, serviceDate } });
const read = (orgId: string) => getOnboardingSeed({ data: { orgId } });
it("saves the show, checklist and cue sheet atomically and reads the exact show even on a shared date", async () => {
  const f = await fixture();
  await getPrisma().rundown.create({ data: { id: crypto.randomUUID(), orgId: f.orgId, name: "Another same-day show", serviceDate: date } });
  const result = await seed(f.orgId);
  expect(result).toMatchObject({ status: "saved", template: "sunday", serviceDate: date, showId: `${f.orgId}:onboarding:show` });
  if (result.status !== "saved") throw new Error("Missing seed");
  expect(result.items).toHaveLength(9);
  expect(await getPrisma().checklistTemplate.count({ where: { orgId: f.orgId } })).toBe(5);
  expect(await getPrisma().cueNote.count({ where: { orgId: f.orgId } })).toBe(4);
  expect(await getPrisma().cueColumn.count({ where: { orgId: f.orgId } })).toBe(5);
  expect(await read(f.orgId)).toEqual(result);
});
it("preserves edits and deletions when a lost acknowledgement is retried with a different date or template", async () => {
  const f = await fixture(); await seed(f.orgId);
  await env.DB.prepare("UPDATE rundown_item SET title = 'Operator edit' WHERE orgId = ? AND itemId = ?").bind(f.orgId, `${f.orgId}:onboarding:item:0`).run();
  await env.DB.prepare("DELETE FROM rundown_item WHERE orgId = ? AND itemId = ?").bind(f.orgId, `${f.orgId}:onboarding:item:1`).run();
  await env.DB.prepare("UPDATE checklist_template SET label = 'Checklist edit' WHERE orgId = ? AND sortOrder = 0").bind(f.orgId).run();
  await env.DB.prepare("UPDATE cue_note SET text = 'Cue edit' WHERE orgId = ?").bind(f.orgId).run();
  const result = await seed(f.orgId, "youth", "2026-11-08");
  expect(result).toMatchObject({ status: "saved", template: "sunday", serviceDate: date });
  if (result.status !== "saved") throw new Error("Missing seed");
  expect(result.items).toHaveLength(8); expect(result.items[0].title).toBe("Operator edit");
  expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(1);
  expect((await getPrisma().checklistTemplate.findMany({ where: { orgId: f.orgId }, orderBy: { sortOrder: "asc" } }))[0].label).toBe("Checklist edit");
  expect((await getPrisma().cueNote.findMany({ where: { orgId: f.orgId } })).every(row => row.text === "Cue edit")).toBe(true);
});
it("chooses one complete template under simultaneous different choices", async () => {
  const f = await fixture(); const results = await Promise.all([seed(f.orgId), seed(f.orgId, "youth", "2026-11-08")]);
  expect(results[0]).toEqual(results[1]); const result = results[0];
  if (result.status !== "saved") throw new Error("Missing seed");
  expect(result.items).toHaveLength(result.template === "sunday" ? 9 : 6);
  expect(await getPrisma().checklistTemplate.count({ where: { orgId: f.orgId } })).toBe(result.template === "sunday" ? 5 : 3);
  expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(1);
});
it("serializes the no-rundown escape with a pending seed without clearing either result", async () => {
  const f = await fixture(); const results = await Promise.all([seed(f.orgId, "blank"), seed(f.orgId)]);
  expect(results[0]).toEqual(results[1]); const result = results[0];
  if (result.status !== "saved") throw new Error("Missing seed");
  const blank = result.template === "blank";
  expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(blank ? 0 : 1);
  expect(await getPrisma().cueColumn.count({ where: { orgId: f.orgId } })).toBe(blank ? 0 : 5);
  expect(await seed(f.orgId)).toEqual(result);
});
it("does not resurrect a deleted show or overwrite an unreadable marker", async () => {
  const f = await fixture(); await seed(f.orgId);
  await getPrisma().rundown.deleteMany({ where: { orgId: f.orgId } });
  expect(await seed(f.orgId)).toMatchObject({ status: "review" });
  await env.DB.prepare("UPDATE app_setting SET value = 'damaged' WHERE orgId = ? AND key = 'onboarding-template-seeded'").bind(f.orgId).run();
  expect(await seed(f.orgId, "blank")).toMatchObject({ status: "review" });
  expect((await getOnboardingProgress({ data: { mode: "resume", orgId: f.orgId } })).seededTemplate).toBe("");
  expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(0);
  expect((await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'onboarding-template-seeded'").bind(f.orgId).first<{ value: string }>())?.value).toBe("damaged");
});
it("protects old partial seeds and permits an explicit continuation that retains them", async () => {
  const f = await fixture();
  const show = await getPrisma().rundown.create({ data: { id: `${f.orgId}:onboarding:show`, orgId: f.orgId, name: "Edited old seed", serviceDate: date } });
  await getPrisma().checklistTemplate.create({ data: { id: `${f.orgId}:onboarding:checklist:0`, orgId: f.orgId, label: "Keep checklist", category: "video" } });
  expect(await seed(f.orgId)).toMatchObject({ status: "review" });
  expect(await getPrisma().rundownItem.count({ where: { orgId: f.orgId } })).toBe(0);
  expect(await seed(f.orgId, "blank")).toMatchObject({ status: "saved", template: "blank", showId: show.id });
  expect((await getPrisma().rundown.findUnique({ where: { id: show.id } }))?.name).toBe("Edited old seed");
  expect((await getPrisma().checklistTemplate.findMany({ where: { orgId: f.orgId } }))[0].label).toBe("Keep checklist");
});
it("keeps saved result recovery available after a workspace change or full show allowance", async () => {
  const f = await fixture(); await seed(f.orgId);
  await getPrisma().appSetting.create({ data: { orgId: f.orgId, key: "workspace-type", value: "theatre" } });
  for (let i = 0; i < 3; i++) await getPrisma().rundown.create({ data: { orgId: f.orgId, serviceDate: date } });
  expect(await seed(f.orgId)).toMatchObject({ status: "saved", template: "sunday" });
});
it("checks plan limits before a new seed but lets a full workspace continue without a new show", async () => {
  const f = await fixture(); await getPrisma().organization.update({ where: { id: f.orgId }, data: { plan: "free", trialEndsAt: null, betaTester: false } });
  for (let i = 0; i < 3; i++) await getPrisma().rundown.create({ data: { orgId: f.orgId, serviceDate: date } });
  await expect(seed(f.orgId)).rejects.toThrow("allows up to");
  expect(await read(f.orgId)).toEqual({ status: "empty" });
  expect(await seed(f.orgId, "blank")).toMatchObject({ status: "saved", template: "blank", items: [], showId: null });
});
it("rejects foreign or revoked access, invalid inputs, and a template outside the workspace", async () => {
  const other = await fixture(); const f = await fixture();
  await expect(read(other.orgId)).rejects.toThrow(); await expect(seed(other.orgId)).rejects.toThrow();
  await expect(seed(f.orgId, "two-act")).rejects.toThrow("Unknown template");
  await expect(seed(f.orgId, "invalid")).rejects.toThrow();
  await expect(seed(f.orgId, "sunday", "invalid")).rejects.toThrow();
  await getPrisma().member.deleteMany({ where: { organizationId: f.orgId } });
  await expect(read(f.orgId)).rejects.toThrow(); await expect(seed(f.orgId)).rejects.toThrow();
  expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(0);
});
it("rolls back even the completion marker and default columns if the last cue insert fails", async () => {
  const f = await fixture();
  await env.DB.prepare(`CREATE TRIGGER fail_setup_cue BEFORE INSERT ON cue_note WHEN NEW.orgId = '${f.orgId}' BEGIN SELECT RAISE(ABORT, 'Fixture cue failure'); END`).run();
  try {
    await expect(seed(f.orgId)).rejects.toThrow();
    expect(await read(f.orgId)).toEqual({ status: "empty" });
    expect(await getPrisma().rundown.count({ where: { orgId: f.orgId } })).toBe(0);
    expect(await getPrisma().checklistTemplate.count({ where: { orgId: f.orgId } })).toBe(0);
    expect(await getPrisma().cueColumn.count({ where: { orgId: f.orgId } })).toBe(0);
    expect(await getPrisma().appSetting.count({ where: { orgId: f.orgId, key: "cue-sheet-default-columns" } })).toBe(0);
  } finally { await env.DB.prepare("DROP TRIGGER fail_setup_cue").run(); }
  expect(await seed(f.orgId)).toMatchObject({ status: "saved" });
});
it("preserves existing cue columns and does not recreate intentionally deleted defaults", async () => {
  const f = await fixture();
  await getPrisma().appSetting.create({ data: { orgId: f.orgId, key: "cue-sheet-default-columns", value: "1" } });
  await getPrisma().cueColumn.create({ data: { id: crypto.randomUUID(), orgId: f.orgId, label: "Production", sortOrder: 0, color: "violet" } });
  await getPrisma().cueColumn.create({ data: { id: crypto.randomUUID(), orgId: f.orgId, label: "Production", sortOrder: 1, color: "orange" } });
  await seed(f.orgId);
  expect(await getPrisma().cueColumn.count({ where: { orgId: f.orgId } })).toBe(2);
  expect(await getPrisma().cueNote.count({ where: { orgId: f.orgId } })).toBe(2);
});
