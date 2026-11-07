import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { CredentialVault } from "../credential-vault.server";
import { backfillCredentialSettings, encryptSettingValue, readSettingValuesForUse } from "../credential-settings.server";
import { CREDENTIAL_MASK } from "../credential-fields";
import { loadExternalChatConfiguration } from "../external-chat-gateway";
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
import { updateOrgSetting, updateOrgCredential, bulkUpdateOrgSettings, getManageableOrgSettings, getRecentWebhookEvents } from "../settings";
const secret = "fixture-password-do-not-return";
const key = "propresenter-password";
const binding = env.CREDENTIAL_ENCRYPTION_KEYS;
afterEach(() => { env.CREDENTIAL_ENCRYPTION_KEYS = binding; });
async function fixture() {
  const member = await seedRelayMember(`secret-settings-${crypto.randomUUID()}`);
  auth.userId = member.userId;
  await env.DB.prepare("UPDATE organization SET plan = 'pro' WHERE id = ?").bind(member.orgId).run();
  return member;
}
async function stored(orgId: string, settingKey = key) {
  return await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?").bind(orgId, settingKey).first<string>("value");
}
async function seed(orgId: string, settingKey: string, value: string) {
  await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value")
    .bind(crypto.randomUUID(), orgId, settingKey, value).run();
}

it("encrypts real settings writes, masks every generic read/save response and preserves unrelated values", async () => {
  const { orgId } = await fixture();
  expect(await updateOrgCredential({ data: { orgId, key, change: { action: "replace", value: secret } } })).toEqual({ key, value: CREDENTIAL_MASK });
  const encrypted = await stored(orgId);
  expect(encrypted).toMatch(/^spenc:v1:/);
  expect(encrypted).not.toContain(secret);
  const vault = await CredentialVault.fromSecret(binding);
  expect(await vault.decrypt({ kind: "setting", orgId, key }, encrypted!)).toBe(secret);
  expect(await getManageableOrgSettings({ data: { orgId } })).toHaveProperty(key, CREDENTIAL_MASK);
  expect(await updateOrgSetting({ data: { orgId, key: "slack-token", value: secret } })).toEqual({ key: "slack-token", value: CREDENTIAL_MASK });
  expect(await bulkUpdateOrgSettings({ data: { orgId, settings: [{ key: "slack-channel", value: "production" }, { key: "mattermost-token", value: secret }] } })).toEqual([{ key: "slack-channel", value: "production" }, { key: "mattermost-token", value: CREDENTIAL_MASK }]);
  expect(await stored(orgId, "slack-channel")).toBe("production");
  expect(await stored(orgId, "mattermost-token")).toMatch(/^spenc:v1:/);
});

it("keeps the latest saved credential without rewriting it, accepts explicit replacement and clears intentionally", async () => {
  const { orgId } = await fixture();
  await updateOrgCredential({ data: { orgId, key, change: { action: "replace", value: secret } } });
  await updateOrgCredential({ data: { orgId, key, change: { action: "replace", value: "rotated" } } });
  const rotated = await stored(orgId);
  await updateOrgCredential({ data: { orgId, key, change: { action: "keep" } } });
  await updateOrgSetting({ data: { orgId, key, value: CREDENTIAL_MASK } });
  await bulkUpdateOrgSettings({ data: { orgId, settings: [{ key, value: CREDENTIAL_MASK }] } });
  expect(await stored(orgId)).toBe(rotated);
  expect(await updateOrgCredential({ data: { orgId, key, change: { action: "clear" } } })).toEqual({ key, value: "" });
  expect(await stored(orgId)).toBe("");
});

it("enforces organization membership and settings permission before accessing a credential", async () => {
  const first = await fixture(); const second = await fixture();
  await expect(updateOrgCredential({ data: { orgId: first.orgId, key, change: { action: "replace", value: secret } } })).rejects.toThrow("Forbidden");
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(second.orgId, second.userId).run();
  await expect(updateOrgSetting({ data: { orgId: second.orgId, key, value: secret } })).rejects.toThrow("Forbidden");
  await expect(updateOrgCredential({ data: { orgId: second.orgId, key, change: { action: "clear" } } })).rejects.toThrow("Forbidden");
  expect(await stored(first.orgId)).toBeNull();
  expect(await stored(second.orgId)).toBeNull();
});

it("fails closed without encryption keys before bulk writes, while allowing nonsecret changes and credential removal", async () => {
  const { orgId } = await fixture();
  await seed(orgId, key, secret);
  env.CREDENTIAL_ENCRYPTION_KEYS = undefined;
  await expect(updateOrgSetting({ data: { orgId, key, value: "new-secret" } })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  await expect(bulkUpdateOrgSettings({ data: { orgId, settings: [{ key: "org-timezone", value: "should-not-write" }, { key, value: "new-secret" }] } })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  expect(await stored(orgId, "org-timezone")).toBeNull();
  expect(await stored(orgId)).toBe(secret);
  await updateOrgSetting({ data: { orgId, key: "org-timezone", value: "allowed" } });
  await updateOrgCredential({ data: { orgId, key, change: { action: "clear" } } });
  expect(await stored(orgId)).toBe("");
});

it("reads encrypted integration credentials internally, supports legacy values during migration and rejects copied ciphertext", async () => {
  const { orgId } = await fixture();
  const encrypted = await encryptSettingValue(binding, orgId, "slack-token", secret);
  await seed(orgId, "chat-adapter", "slack"); await seed(orgId, "slack-channel", "production"); await seed(orgId, "slack-token", encrypted);
  expect(await loadExternalChatConfiguration(env.DB, orgId, binding)).toEqual({ platform: "slack", channelId: "production", token: secret });
  await expect(loadExternalChatConfiguration(env.DB, orgId)).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  await expect(readSettingValuesForUse(binding, "another-org", [{ key: "slack-token", value: encrypted }])).rejects.toThrow("storage identity");
  await expect(readSettingValuesForUse(binding, orgId, [{ key, value: encrypted }])).rejects.toThrow("storage identity");
  expect(await readSettingValuesForUse(undefined, orgId, [{ key, value: secret }])).toEqual({ [key]: secret });
});

it("backfills complete bounded sweeps and preserves a simultaneous credential replacement", async () => {
  const { orgId } = await fixture();
  await seed(orgId, key, secret);
  await seed(orgId, "teams-webhook-url", "https://example.test/secret-hook");
  await seed(orgId, "org-label", "unchanged");
  await seed(orgId, "api-key", "legacy-bridge-owned-by-other-migration");
  await env.DB.prepare("DELETE FROM credential_backfill_cursor WHERE name='settings'").run();
  let raced = false;
  const racedDb = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!raced) { raced = true; await seed(orgId, key, "concurrent-replacement"); }
      return target.batch<T>(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  // Position immediately before our fixtures so this batch actually competes with the edited row.
  const first = await env.DB.prepare("SELECT MIN(rowid) AS first FROM app_setting WHERE orgId=?").bind(orgId).first<number>("first");
  await env.DB.prepare("INSERT INTO credential_backfill_cursor (name,lastRowId) VALUES ('settings',?)").bind(first! - 1).run();
  const result = await backfillCredentialSettings(racedDb, binding, 3);
  expect(result.scanned).toBe(3);
  expect(await stored(orgId)).toBe("concurrent-replacement");
  let next = result;
  for (let count = 0; count < 100; count++) {
    next = await backfillCredentialSettings(env.DB, binding, 3);
    if (next.sweepComplete) break;
  }
  expect(next.sweepComplete).toBe(true);
  // Next full sweep revisits the row changed while the previous one was in flight.
  for (let count = 0; count < 100; count++) {
    next = await backfillCredentialSettings(env.DB, binding, 100);
    if (next.sweepComplete) break;
  }
  const after = await stored(orgId);
  expect(after).toMatch(/^spenc:v1:/);
  expect(await readSettingValuesForUse(binding, orgId, [{ key, value: after! }])).toEqual({ [key]: "concurrent-replacement" });
  expect(await stored(orgId, "org-label")).toBe("unchanged");
  expect(await stored(orgId, "api-key")).toBe("legacy-bridge-owned-by-other-migration");
  expect(await stored(orgId, "teams-webhook-url")).toMatch(/^spenc:v1:/);
  expect((await backfillCredentialSettings(env.DB, binding)).migrated).toBe(0);
});

it("retains webhook setting history without recording the secret URL", async () => {
  const { orgId } = await fixture();
  const webhook = "https://fixture.invalid/private-authority";
  await updateOrgCredential({ data: { orgId, key: "webhook-url", change: { action: "replace", value: webhook } } });
  await updateOrgCredential({ data: { orgId, key: "webhook-url", change: { action: "clear" } } });
  const events = await getRecentWebhookEvents({ data: { orgId } });
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain(webhook);
  expect(events.map(event => event.details)).toEqual(expect.arrayContaining([
    "Incoming webhook URL has been configured.", "Incoming webhook URL has been cleared.",
  ]));
});


it("hides internal application state from manageable settings", async () => {
  const { orgId, userId } = await fixture();
  await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  await seed(orgId, "rundown-items:fixture-show", '[{"id":"private-rundown-item"}]');
  await seed(orgId, "webhook-events", '[{"details":"internal-history"}]');
  await seed(orgId, "incident-write:fixture-operation", '{"status":"applied"}');
  await seed(orgId, "org-timezone", "America/Toronto");
  const settings = await getManageableOrgSettings({ data: { orgId } });
  expect(settings).toEqual({ "org-timezone": "America/Toronto" });
});

it.each(["rundown-items:fixture-show", "webhook-events", "incident-write:fixture-operation", "propresenter-internal-state", "unknown-token", "schedule-provider", "rundown-items-storage:fixture-show", "constructor", "__proto__"])(
  "rejects internal or unknown setting %s through every generic write path", async (settingKey) => {
    const { orgId, userId } = await fixture();
    await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
    await seed(orgId, settingKey, "protected-value");
    await expect(updateOrgSetting({ data: { orgId, key: settingKey, value: "overwritten" } })).rejects.toThrow("Choose a supported organization setting");
    await expect(bulkUpdateOrgSettings({ data: { orgId, settings: [{ key: "org-timezone", value: "UTC" }, { key: settingKey, value: "overwritten" }] } })).rejects.toThrow("Choose a supported organization setting");
    await expect(updateOrgCredential({ data: { orgId, key: settingKey, change: { action: "clear" } } })).rejects.toThrow("Choose a supported organization setting");
    expect(await stored(orgId, settingKey)).toBe("protected-value");
    expect(await stored(orgId, "org-timezone")).toBeNull();
  },
);


it("keeps explicit setting permissions, organization scoping and credential masking", async () => {
  const first = await fixture();
  await seed(first.orgId, "org-timezone", "Pacific/Auckland");
  const { orgId, userId } = await fixture();
  await seed(orgId, "org-timezone", "America/Toronto");
  await seed(orgId, "slack-token", secret);
  await seed(orgId, "webhook-url", "https://fixture.invalid/private-hook");
  await seed(orgId, "l3-auto-clear", "true");
  await env.DB.prepare("UPDATE member SET role='sm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  expect(await getManageableOrgSettings({ data: { orgId } })).toEqual({
    "org-timezone": "America/Toronto", "slack-token": CREDENTIAL_MASK,
  });
  for (const settingKey of ["webhook-url", "l3-auto-clear"]) {
    await expect(updateOrgSetting({ data: { orgId, key: settingKey, value: "" } })).rejects.toThrow("Forbidden");
  }
  await expect(getManageableOrgSettings({ data: { orgId: first.orgId } })).rejects.toThrow("Forbidden");
  await expect(updateOrgSetting({ data: { orgId: first.orgId, key: "org-timezone", value: "UTC" } })).rejects.toThrow("Forbidden");
  await updateOrgSetting({ data: { orgId, key: "org-timezone", value: "UTC" } });
  expect(await stored(orgId, "org-timezone")).toBe("UTC");
  expect(await stored(first.orgId, "org-timezone")).toBe("Pacific/Auckland");
});
