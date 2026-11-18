import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { ORG_SETTING_KEYS } from "../org-setting-keys";

it("0101 moves exactly 22 keys verbatim in scratch D1, preserving S2a and all state families", async () => {
  const db = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(m => m.name < "0101"));
  await db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES ('s2b','S2b','s2b',CURRENT_TIMESTAMP)").run();
  const moved = ["org-timezone", "clock-format", "rundown-adapter", "ontime-url", "default-call-lead-minutes", "notify-app-chat", "propresenter-host", "propresenter-port", "propresenter-api-port", "propresenter-password", "propresenter-send-cues", "chat-adapter", "slack-token", "slack-channel", "slack-signing-secret", "mattermost-url", "mattermost-token", "mattermost-channel", "teams-webhook-url", "discord-bot-token", "discord-channel-id", "webhook-url"];
  expect(moved).toHaveLength(22);
  expect(ORG_SETTING_KEYS.size).toBe(35);
  const retained = ["api-key", "timezone", "workspace-type", "schedule-provider", "rundown-timer:show", "active-show-id", "active-service-date", "active-graphics", "webhook-events", "setting-write:receipt", "show-deleting:show", "user-pref:person", "propresenter-stage-display"];
  const values = moved.map((key, i) => ({ key, value: ["  bytes\n", "spenc:v1:opaque/+/=", "", "{malformed"][i % 4] }));
  await db.batch([...values, ...retained.map(key => ({ key, value: `retained:${key}` }))].map(({ key, value }) => db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,'s2b',?,?)").bind(crypto.randomUUID(), key, value)));
  const previous = [...ORG_SETTING_KEYS].filter(key => !moved.includes(key));
  await db.batch(previous.flatMap(key => [
    db.prepare("INSERT INTO org_setting(orgId,key,value,updatedAt) VALUES ('s2b',?,'s2a','original')").bind(key),
    db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,'s2b',?,'legacy-s2a')").bind(crypto.randomUUID(), key),
  ]));
  const readApp = async () => (await db.prepare("SELECT key,value FROM app_setting WHERE orgId='s2b' ORDER BY key").all<{key:string;value:string}>()).results;
  const readOrg = async () => (await db.prepare("SELECT key,value FROM org_setting WHERE orgId='s2b' ORDER BY key").all<{key:string;value:string}>()).results;
  const beforeApp = await readApp(); const beforeOrg = await readOrg();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(m => m.name < "0102"));
  expect(await readApp()).toEqual(beforeApp.filter(row => !moved.includes(row.key)));
  expect(await readOrg()).toEqual([...beforeOrg, ...values].sort((a,b) => a.key.localeCompare(b.key)));
  expect(await db.prepare("SELECT updatedAt FROM org_setting WHERE orgId='s2b' AND key='lyrics-output'").first("updatedAt")).toBe("original");
});


vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: "mobile-s2b", name: "Operator", email: "mobile@example.test" } }) } }) }));
vi.mock("../effective-access", async (original) => ({
  ...await original<typeof import("../effective-access")>(),
  resolveEffectiveAccess: async () => ({ role: "owner", permissions: ["show:view", "rundown:view", "rundown:edit"], today: "2026-11-17" }),
  resolveAccessGrantAuthorityForAccess: async () => null,
}));

it("mobile bootstrap and templates payloads are byte-identical from seeded legacy fixtures after 0101", async () => {
  const { handleMobileApi } = await import("../mobile-api.server");
  const db = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const orgId = "mobile-s2b";
  await db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES (?, 'Mobile', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  await db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES ('mobile-s2b-zone',?,'org-timezone','Pacific/Honolulu')").bind(orgId).run();
  await db.prepare("INSERT INTO rundown(id,orgId,serviceDate,name) VALUES ('mobile-s2b-show',?,'2099-01-01','Show')").bind(orgId).run();
  const payload = JSON.stringify({ id: "legacy-template", name: "Legacy template", serviceName: "Service", scheduledStartTime: "09:30", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", items: [{ id: "one", title: "Opening", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false, actualStart: null, actualEnd: null }] });
  await db.prepare("INSERT INTO rundown_template(id,orgId,templateId,name,updatedAt,payload) VALUES ('mobile-s2b-template',?,'legacy-template','Legacy template','2026-01-01',?)").bind(orgId, payload).run();
  // Execute the pre-move query against the seeded legacy table without changing production routing.
  const legacy = new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql: string) => target.prepare(sql.replaceAll("FROM org_setting", "FROM app_setting"));
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const read = async (database: D1Database, path: string) => {
    const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/${path}?orgId=${orgId}`), { DB: database });
    expect(response?.status).toBe(200);
    return response!.text();
  };
  const paths = ["bootstrap", "rundowns/mobile-s2b-show/templates"];
  const before = await Promise.all(paths.map(path => read(legacy, path)));
  expect(JSON.parse(before[0]).timeZone).toBe("Pacific/Honolulu");
  expect(JSON.parse(before[1]).templates).toHaveLength(1);
  const migration = env.TEST_MIGRATIONS.find(m => m.name.startsWith("0101"))!;
  await db.batch(migration.queries.map(query => db.prepare(query)));
  expect(await Promise.all(paths.map(path => read(db, path)))).toEqual(before);
});

vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
