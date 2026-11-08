import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture", email: "fixture@example.test" } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { clearActiveGraphics, getActiveGraphics } from "../graphics";
import { withDatabaseRequest } from "../request-database.server";
import { issueDisplayPass } from "../display-access.server";
import { handleOverlayGet } from "../../routes/api/overlay/$orgSlug";
async function fixture() {
  const member = await seedRelayMember(`graphics-output-${crypto.randomUUID()}`);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(member.orgId).run();
  const old = `${member.orgId}-old`, later = `${member.orgId}-later`;
  for (const id of [old, later]) await env.DB.prepare("INSERT INTO graphic_template (id,orgId,name,title,subtitle,style,createdAt,updatedAt) VALUES (?,?,'Fixture','Fixture','','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, member.orgId).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-graphics',?)").bind(crypto.randomUUID(), member.orgId, JSON.stringify([old])).run();
  return { ...member, old, later };
}
it("returns confirmed empty output and preserves organization authorization", async () => {
  const own = await fixture(), other = await fixture(); auth.userId = own.userId;
  await expect(clearActiveGraphics({ data: { orgId: other.orgId } })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key='active-graphics'").bind(other.orgId).first()).toEqual({ value: JSON.stringify([other.old]) });
  expect(await clearActiveGraphics({ data: { orgId: own.orgId } })).toEqual([]);
  expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key='active-graphics'").bind(own.orgId).first()).toBeNull();
});
it("returns a publication that arrives immediately after Clear instead of assuming empty output", async () => {
  const f = await fixture(); auth.userId = f.userId;
  const trigger = `publish_after_clear_${crypto.randomUUID().replaceAll("-", "")}`;
  // Model another publisher at the clear/write boundary using real SQLite state.
  await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER DELETE ON app_setting WHEN OLD.orgId='${f.orgId}' AND OLD.key='active-graphics' BEGIN INSERT INTO app_setting (id,orgId,key,value) VALUES (OLD.id,OLD.orgId,'active-graphics','["${f.later}"]'); END`).run();
  try { expect(await clearActiveGraphics({ data: { orgId: f.orgId } })).toEqual([f.later]); }
  finally { await env.DB.prepare(`DROP TRIGGER ${trigger}`).run(); }
});

it("reads live output from primary even without a recent-write cookie", async () => {
  const f = await fixture(); auth.userId = f.userId;
  const sessions: D1SessionConstraint[] = [];
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "withSession") return (constraint: D1SessionConstraint) => { sessions.push(constraint); return target.withSession(constraint); };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await withDatabaseRequest(new Request("https://graphics.test/_serverFn/output"), database,
    async () => Response.json(await getActiveGraphics({ data: { orgId: f.orgId } })));
  expect((await response.json<{ id: string }[]>()).map(row => row.id)).toEqual([f.old]);
  expect(sessions).toEqual([]);
});

it("reads overlay publication, clear, and replacement from primary on a separate display client", async () => {
  const f = await fixture();
  const pass = await issueDisplayPass(f.orgId, "overlay", env.KIOSK_SECRET);
  const sessions: D1SessionConstraint[] = [];
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "withSession") return (constraint: D1SessionConstraint) => { sessions.push(constraint); return target.withSession(constraint); };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const read = async () => {
    const request = new Request(`https://graphics.test/api/overlay/${f.orgId}`, {
      headers: { "x-showpilot-display-pass": pass.token },
    });
    const response = await withDatabaseRequest(request, database, () =>
      handleOverlayGet({ params: { orgSlug: f.orgId }, request }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return (await response.json<{ id: string }[]>()).map(row => row.id);
  };
  expect(await read()).toEqual([f.old]);
  await env.DB.prepare("DELETE FROM app_setting WHERE orgId=? AND key='active-graphics'").bind(f.orgId).run();
  expect(await read()).toEqual([]);
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-graphics',?)").bind(crypto.randomUUID(), f.orgId, JSON.stringify([f.later])).run();
  expect(await read()).toEqual([f.later]);
  expect(sessions).toEqual([]);
});
