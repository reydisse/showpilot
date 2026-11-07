import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { getSetupChoices, saveSetupWorkspace, saveSetupRole } from "../setup-choices";
import { saveSetupChoice } from "../setup-choices.server";
import { setupChoiceConfirmed, parseSetupRole, type SetupChoiceCommand, type SetupChoicesSnapshot } from "../setup-choices-contract";
import { setWorkspaceType, setWorkspaceModules } from "../workspace/profile";
import { workspaceD1Store, workspacePrismaStore, writeWorkspaceProfile } from "../workspace/profile.server";
import { handleMobileApi } from "../mobile-api.server";
import { resolveWorkspaceProfile } from "@showpilot/shared";
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
const read = (orgId: string) => getSetupChoices({ data: { orgId } });
const workspace = (orgId: string, snapshot: SetupChoicesSnapshot, type: "church" | "custom" | "school" | "theatre" = "custom"): Extract<SetupChoiceCommand, { kind: "workspace" }> => ({ kind: "workspace", orgId, requestId: crypto.randomUUID(), expectedRevision: snapshot.workspaceRevision, selection: { type, custom: { label: " Tour ", terms: { event: " Gig ", item: " Act " } }, modules: ["chat"] } });
const role = (orgId: string, snapshot: SetupChoicesSnapshot, archetype: "td" | "pm" | "sm" = "td"): Extract<SetupChoiceCommand, { kind: "role" }> => ({ kind: "role", orgId, requestId: crypto.randomUUID(), expectedRevision: snapshot.roleValue, archetype });
it("confirms normalized workspace choices and per-user roles without changing account permissions", async () => {
  const f = await fixture(); const command = workspace(f.orgId, await read(f.orgId));
  const first = await saveSetupWorkspace({ data: command }); expect(setupChoiceConfirmed(first, command)).toBe(true);
  expect(resolveWorkspaceProfile(first.settings)).toMatchObject({ type: "custom", label: "Tour", terms: { event: "gig", item: "Act" }, modules: ["show", "rundown", "team", "chat"] });
  const selected = role(f.orgId, first, "pm"); const result = await saveSetupRole({ data: selected });
  expect(setupChoiceConfirmed(result, selected)).toBe(true); expect(parseSetupRole(result.roleValue)?.archetype).toBe("pm");
  expect((await getPrisma().member.findFirst({ where: { organizationId: f.orgId, userId: f.userId } }))?.role).toBe("owner");
  expect(await read(f.orgId)).toEqual(result);
});
it("replays an identical request as a read and rejects reusing its identity for a different choice", async () => {
  const f = await fixture(); const command = workspace(f.orgId, await read(f.orgId)); const first = await saveSetupWorkspace({ data: command });
  await env.DB.prepare(`CREATE TRIGGER block_choice_replay BEFORE UPDATE ON app_setting WHEN NEW.orgId = '${f.orgId}' BEGIN SELECT RAISE(ABORT, 'Should not write a replay'); END`).run();
  try { expect(await saveSetupWorkspace({ data: command })).toEqual(first); }
  finally { await env.DB.prepare("DROP TRIGGER block_choice_replay").run(); }
  await expect(saveSetupWorkspace({ data: { ...command, selection: { type: "school" } } })).rejects.toThrow("different workspace choice");
  const selected = role(f.orgId, first); const second = await saveSetupRole({ data: selected });
  expect(await saveSetupRole({ data: selected })).toEqual(second);
  await expect(saveSetupRole({ data: { ...selected, archetype: "sm" } })).rejects.toThrow("different team role");
});
it("chooses one concurrent workspace and returns the winner for review to the other request", async () => {
  const f = await fixture(); const before = await read(f.orgId); const commands = [workspace(f.orgId, before, "school"), workspace(f.orgId, before, "theatre")];
  const results = await Promise.all(commands.map(data => saveSetupWorkspace({ data })));
  expect(results[0]).toEqual(results[1]); expect(commands.filter(command => setupChoiceConfirmed(results[0], command))).toHaveLength(1);
  expect(["school", "theatre"]).toContain(resolveWorkspaceProfile(results[0].settings).type);
});
it("rejects a concurrent attempt to reuse one request ID with different content", async () => {
  const f = await fixture(); const command = workspace(f.orgId, await read(f.orgId), "school");
  const results = await Promise.allSettled([saveSetupWorkspace({ data: command }), saveSetupWorkspace({ data: { ...command, selection: { type: "theatre" } } })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
});
it("keeps a newer setup role when an older pending choice or retry arrives late", async () => {
  const f = await fixture(); const before = await read(f.orgId); const old = role(f.orgId, before, "td");
  const newer = role(f.orgId, before, "sm"); const saved = await saveSetupRole({ data: newer });
  expect(await saveSetupRole({ data: old })).toEqual(saved); expect(setupChoiceConfirmed(saved, old)).toBe(false);
  const latest = role(f.orgId, saved, "pm"); const result = await saveSetupRole({ data: latest });
  expect(await saveSetupRole({ data: newer })).toEqual(result); expect(parseSetupRole(result.roleValue)?.archetype).toBe("pm");
});
it("detects web Settings changes even when values return to the same workspace type", async () => {
  const f = await fixture(); await setWorkspaceType({ data: { orgId: f.orgId, type: "church", resetModules: true } });
  const before = await read(f.orgId); const delayed = workspace(f.orgId, before, "custom");
  await setWorkspaceType({ data: { orgId: f.orgId, type: "school", resetModules: false } });
  await setWorkspaceType({ data: { orgId: f.orgId, type: "church", resetModules: false } });
  await setWorkspaceModules({ data: { orgId: f.orgId, modules: ["chat"] } });
  const newer = await read(f.orgId); expect(newer.workspaceRevision).not.toBe(before.workspaceRevision);
  expect(await saveSetupWorkspace({ data: delayed })).toEqual(newer); expect(resolveWorkspaceProfile(newer.settings).type).toBe("church");
});
it("detects real mobile workspace changes before a pending web setup save", async () => {
  const f = await fixture(); const delayed = workspace(f.orgId, await read(f.orgId), "custom");
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/workspace/initial?orgId=${f.orgId}`, {
    method: "POST", headers: { Cookie: auth.cookie, "Content-Type": "application/json", Origin: "https://app.showpilot.tech" }, body: JSON.stringify({ type: "theatre" }),
  }), { DB: env.DB });
  if (!response) throw new Error("Mobile route did not handle the request");
  expect(response.status).toBe(200); await response.arrayBuffer();
  const actual = await read(f.orgId); expect(actual.workspaceRevision).not.toBeNull();
  expect(await saveSetupWorkspace({ data: delayed })).toEqual(actual); expect(resolveWorkspaceProfile(actual.settings).type).toBe("theatre");
});
it("rolls back the revision and all workspace fields if the last insert fails", async () => {
  const f = await fixture(); const before = await read(f.orgId); const command = workspace(f.orgId, before);
  await env.DB.prepare(`CREATE TRIGGER fail_choice_custom BEFORE INSERT ON app_setting WHEN NEW.orgId = '${f.orgId}' AND NEW.key = 'workspace-custom' BEGIN SELECT RAISE(ABORT, 'Fixture last field failure'); END`).run();
  try { await expect(saveSetupWorkspace({ data: command })).rejects.toThrow(); expect(await read(f.orgId)).toEqual(before); }
  finally { await env.DB.prepare("DROP TRIGGER fail_choice_custom").run(); }
  expect(setupChoiceConfirmed(await saveSetupWorkspace({ data: command }), command)).toBe(true);
});
it("keeps initialization-only guards and revision writes atomic in both workspace stores", async () => {
  const f = await fixture();
  await writeWorkspaceProfile(workspaceD1Store(env.DB, f.orgId), { kind: "initial", type: "school", onlyIfUnconfigured: true });
  const before = await read(f.orgId); expect(before.workspaceRevision).not.toBeNull();
  await expect(writeWorkspaceProfile(await workspacePrismaStore(f.orgId), { kind: "initial", type: "theatre", onlyIfUnconfigured: true })).rejects.toThrow("already configured");
  expect(await read(f.orgId)).toEqual(before);
});
it("limits setup to owners, rejects foreign scope and validates inputs before writes", async () => {
  const other = await fixture(); const f = await fixture(); const before = await read(f.orgId);
  await expect(read(other.orgId)).rejects.toThrow();
  await expect(saveSetupWorkspace({ data: workspace(other.orgId, before) })).rejects.toThrow();
  await expect(saveSetupWorkspace({ data: { ...workspace(f.orgId, before), selection: { type: "custom", custom: { label: "<invalid>", terms: {} } } } })).rejects.toThrow();
  await expect(saveSetupRole({ data: { ...role(f.orgId, before), archetype: "admin" } })).rejects.toThrow();
  for (const level of ["admin", "member"]) {
    await getPrisma().member.updateMany({ where: { organizationId: f.orgId }, data: { role: level } });
    await expect(read(f.orgId)).rejects.toThrow("Forbidden"); await expect(saveSetupRole({ data: role(f.orgId, before) })).rejects.toThrow("Forbidden");
    await expect(saveSetupWorkspace({ data: workspace(f.orgId, before) })).rejects.toThrow("Forbidden");
  }
  expect(await getPrisma().appSetting.count({ where: { orgId: f.orgId } })).toBe(0);
});
it("does not cross user boundaries when two owners personalize their views", async () => {
  const f = await fixture(); const before = await read(f.orgId); const otherUser = crypto.randomUUID();
  await saveSetupRole({ data: role(f.orgId, before, "sm") });
  await saveSetupChoice(env.DB, otherUser, role(f.orgId, before, "pm"));
  expect(parseSetupRole((await read(f.orgId)).roleValue)?.archetype).toBe("sm");
  expect((await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?").bind(f.orgId, `onboarding-role:${otherUser}`).first<{ value: string }>())?.value).toContain('"archetype":"pm"');
});
