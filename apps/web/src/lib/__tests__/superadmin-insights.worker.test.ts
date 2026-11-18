import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { getAuditLog, getFeatureUsage, getOrg360 } from "../superadmin";
const state = vi.hoisted(() => ({ session: null as null | { user: { email: string } } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => { const chain = { inputValidator: () => chain, handler: (fn: unknown) => fn }; return chain; } }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("../email", () => ({ sendEmail: vi.fn(), waitlistInviteEmail: vi.fn() }));
vi.mock("../plan-limits", () => ({ getPublicLaunchDate: async () => null, getEffectivePlan: (org: { plan: string }) => org.plan }));
const fixture = { id: "demo-insights", name: "Demo Insights", slug: "demo-insights", plan: "pro", createdAt: new Date(), cloud_enabled: true };
vi.mock("../db", () => ({ getPrisma: () => ({
  organization: { findMany: async () => [fixture, { id: "empty", name: "Empty" }], findUniqueOrThrow: async () => fixture },
  member: { findMany: async () => [{ id: "member", role: "owner", user: { name: "Demo", email: "demo@example.com" } }] },
  rundown: { findMany: async ({ where }: any) => where.orgId === "empty" ? [] : [{ name: "Sunday", status: "draft", serviceDate: "2026-11-18" }] },
  device: { findMany: async ({ where }: any) => where.orgId === "empty" ? [] : [{ name: "Demo console", category: "audio", enabled: true }] },
  bridgeInstallation: { findMany: async () => [] },
}) }));
const invoke = (fn: unknown, data: unknown) => (fn as (args: { data: unknown }) => Promise<any>)({ data });
beforeEach(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO organization(id,name,slug,createdAt) VALUES (?,?,?,?)").bind(fixture.id, fixture.name, fixture.slug, Date.now()).run();
  state.session = { user: { email: "reydisse@gmail.com" } }; });
it.each([null, { user: { email: "ordinary@example.com" } }])("rejects every endpoint for unauthorized session %j", async session => {
  state.session = session;
  for (const [fn, data] of [[getOrg360, { orgId: "demo-insights" }], [getAuditLog, { page: 0 }], [getFeatureUsage, { days: 30 }]]) await expect(invoke(fn, data)).rejects.toThrow("Unauthorized");
});
it("returns Demo members, billing, shows and devices and empty sections", async () => {
  const result = await invoke(getOrg360, { orgId: fixture.id });
  expect(result.members[0].role).toBe("owner"); expect(result.billing.effectivePlan).toBe("pro");
  expect(result.shows).toHaveLength(1); expect(result.devices).toHaveLength(1);
  const empty = await invoke(getOrg360, { orgId: "empty" });
  expect(empty.shows).toEqual([]); expect(empty.devices).toEqual([]); expect(empty.activity).toEqual([]);
});
it("normalizes audit sources and applies all filters and stable pagination", async () => {
  // Raw audit rows intentionally have unresolved actors, exercising the fallback.
  const now = Date.now();
  for (let i = 0; i < 55; i++) await env.DB.prepare("INSERT INTO scoped_token_audit (id,orgId,tokenId,kind,action,actorUserId,createdAt) VALUES (?,?,?,?,?,?,?)").bind(`insight-${i}`, fixture.id, `token-${i}`, "kiosk", "created", "demo-actor", now - i).run();
  const first = await invoke(getAuditLog, { orgId: fixture.id, page: 0 });
  const second = await invoke(getAuditLog, { orgId: fixture.id, page: 1 });
  expect(first.total).toBe(55); expect(second.events).toHaveLength(5);
  expect(second.events.every((e: any) => !first.events.some((f: any) => e.id === f.id))).toBe(true);
  for (const filters of [{ orgId: "empty" }, { actorUserId: "other" }, { source: "bridge-credential" }, { search: "missing" }, { from: now + 1 }, { to: now - 100 }]) expect((await invoke(getAuditLog, { ...filters, page: 0 })).events).toEqual([]);
  expect((await invoke(getAuditLog, { search: "demo-actor", source: "scoped-token", page: 0 })).total).toBe(55);
});
it("counts product usage within the selected window and includes zero activity orgs", async () => {
  const now = Date.now();
  for (const [id, age] of [["usage-recent", 1], ["usage-old", 40]] as const) await env.DB.prepare("INSERT INTO chat_message (id,orgId,senderName,message,createdAt) VALUES (?,?,?,?,?)").bind(id, fixture.id, "Demo", "hello", now - age * 86400000).run();
  const month = await invoke(getFeatureUsage, { days: 30 });
  expect(month.summary.find((s: any) => s.feature === "Chat messages")).toMatchObject({ total: 1, activeOrgs: 1 });
  expect(month.orgs.find((o: any) => o.id === "empty").counts["Chat messages"]).toBe(0);
  expect((await invoke(getFeatureUsage, { days: 90 })).orgs[0].counts["Chat messages"]).toBe(2);
});

it("unions bridge, token and permission grant and revoke events with actor labels", async () => {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('insight-user','Demo Actor','insight@example.com',?,?)").bind(now,now).run();
  await env.DB.prepare("INSERT INTO bridge_installation(id,orgId,label,createdByUserId,createdAt) VALUES ('insight-install',?,'Demo','insight-user',?)").bind(fixture.id,now).run();
  await env.DB.prepare("INSERT INTO bridge_credential(id,orgId,installationId,keyHash,createdAt) VALUES ('insight-key',?,'insight-install','hash',?)").bind(fixture.id,now).run();
  await env.DB.prepare("INSERT INTO bridge_credential_audit(id,orgId,credentialId,action,direction,actorUserId,createdAt) VALUES ('insight-bridge',?,'insight-key','created','inbound','insight-user',?)").bind(fixture.id,now).run();
  await env.DB.prepare("INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,grantedByUserId,createdAt,updatedAt,revokedAt,revokedByUserId) VALUES ('insight-grant',?,'insight-user','device-operator','[]','2026-01-01','insight-user',?,?,?,'insight-user')").bind(fixture.id,now-1000,now,now).run();
  await env.DB.prepare("INSERT INTO scoped_token_audit(id,orgId,tokenId,kind,action,actorUserId,createdAt) VALUES ('insight-token',?,'demo-token','companion','created','insight-user',?)").bind(fixture.id,now).run();
  const result = await invoke(getAuditLog, { orgId: fixture.id, actorUserId: 'insight-user', page: 0 });
  expect(result.total).toBe(4);
  expect(new Set(result.events.map((e: any) => e.source))).toEqual(new Set(['bridge-credential','scoped-token','permission']));
  expect(result.events.every((e: any) => e.actorLabel === 'Demo Actor' && typeof e.createdAtMs === 'number')).toBe(true);
  expect((await invoke(getAuditLog, { search: 'device-operator', page: 0 })).total).toBe(2);
});
