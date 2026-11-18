import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { ORG_SETTING_KEYS } from "../org-setting-keys";

it("0100 moves exactly the proven keys verbatim and preserves excluded families in scratch D1", async () => {
  const db = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(m => !m.name.startsWith("0100")));
  await db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES ('org-migration','Migration','org-migration',CURRENT_TIMESTAMP)").run();
  const excluded = ["org-timezone", "clock-format", "rundown-adapter", "ontime-url", "default-call-lead-minutes", "notify-app-chat", "propresenter-host", "propresenter-port", "propresenter-api-port", "propresenter-password", "propresenter-send-cues", "timezone", "kiosk_blanked", "workspace-type", "schedule-provider", "chat-adapter", "slack-token", "slack-channel", "slack-signing-secret", "mattermost-url", "mattermost-token", "mattermost-channel", "teams-webhook-url", "discord-bot-token", "discord-channel-id", "webhook-url", "rundown-timer:show", "active-show-id", "active-graphics", "webhook-events", "setting-write:receipt", "show-deleting:show", "user-pref:person"];
  const migrated = [...ORG_SETTING_KEYS].map((key, i) => ({ key, value: ['  verbatim\n', 'spenc:v1:opaque', '', '{malformed'][i % 4] }));
  const retained = excluded.map(key => ({ key, value: `unchanged:${key}` }));
  await db.batch([...migrated, ...retained].map(({key,value}, i) => db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,'org-migration',?,?)").bind(String(i),key,value)));
  const before = (await db.prepare("SELECT key,value FROM app_setting WHERE orgId='org-migration'").all<{key:string;value:string}>()).results.filter(row => !ORG_SETTING_KEYS.has(row.key));
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const sort = (rows: {key: string; value: string}[]) => rows.sort((a,b) => a.key.localeCompare(b.key));
  expect(sort((await db.prepare("SELECT key,value FROM org_setting WHERE orgId='org-migration'").all<{key:string;value:string}>()).results)).toEqual(sort(migrated));
  expect(sort((await db.prepare("SELECT key,value FROM app_setting WHERE orgId='org-migration'").all<{key:string;value:string}>()).results)).toEqual(sort(before));
  expect(await db.prepare("SELECT COUNT(*) AS n FROM org_setting WHERE updatedAt IS NULL OR updatedAt=''").first("n")).toBe(0);
  await db.prepare("DELETE FROM organization WHERE id='org-migration'").run();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM org_setting WHERE orgId='org-migration'").first("n")).toBe(0);
});
