import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { CREDENTIAL_MASK } from "../credential-fields";
import { maskDeviceSettings, readDeviceSettingsForUse, writeDeviceSettings, backfillDeviceCredentials } from "../device-settings.server";
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
import { addDevice, getDevice, getDevices, updateDevice } from "../data";
import { handleMobileApi } from "../mobile-api.server";
import { resolveTimecodeDeviceAction } from "../timecode-device-actions";
import { getBlackoutTargets, getAutomationDeviceTargets, getAutomationDeviceNames } from "../automation-targets";
const binding = env.CREDENTIAL_ENCRYPTION_KEYS;
afterEach(() => { env.CREDENTIAL_ENCRYPTION_KEYS = binding; });
async function fixture() {
  const member = await seedRelayMember(`device-credentials-${crypto.randomUUID()}`);
  auth.userId = member.userId;
  await env.DB.prepare("UPDATE organization SET plan='pro' WHERE id=?").bind(member.orgId).run();
  return { ...member, id: crypto.randomUUID(), adapterType: "obs" };
}
async function stored(id: string, orgId: string) {
  return (await env.DB.prepare("SELECT settings FROM device WHERE id=? AND orgId=?").bind(id, orgId).first<string>("settings"))!;
}

it("lists only this organization's enabled blackout-capable lighting names without settings", async () => {
  const mine = await fixture();
  const other = await fixture();
  for (const [id, orgId, adapter, category, enabled] of [
    ["artnet", mine.orgId, "dmx-artnet", "lighting", 1],
    ["sacn", mine.orgId, "dmx-sacn", "lighting", 1],
    ["off", mine.orgId, "dmx-artnet", "lighting", 0],
    ["video", mine.orgId, "dmx-artnet", "video", 1],
    ["unsupported", mine.orgId, "atem", "lighting", 1],
    ["foreign", other.orgId, "dmx-artnet", "lighting", 1],
  ] as const) {
    await env.DB.prepare("INSERT INTO device (id,orgId,name,adapterType,category,settings,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?,'{\"password\":\"private-fixture\"}',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(`${mine.orgId}-${id}`, orgId, id, adapter, category, enabled).run();
  }
  auth.userId = mine.userId;
  expect(await getBlackoutTargets({ data: { orgId: mine.orgId } })).toEqual([
    { id: `${mine.orgId}-artnet`, label: "artnet" }, { id: `${mine.orgId}-sacn`, label: "sacn" },
  ]);
  await expect(getBlackoutTargets({ data: { orgId: other.orgId } })).rejects.toThrow();
});

it("encrypts actual web writes and masks list, detail and creation returns, including nested legacy credentials", async () => {
  const device = await fixture();
  const settings = { host: "10.0.0.8", port: 4455, password: "obs-fixture-secret", nested: { Authorization: "private-header" }, rows: [{ token: "nested-token" }], embedded: JSON.stringify({ apiKey: "embedded-key", label: "public" }) };
  const created = await addDevice({ data: { orgId: device.orgId, name: "Fixture OBS", category: "streaming", adapterType: "obs", settings: JSON.stringify(settings) } });
  const saved = await stored(created.id, device.orgId);
  const outputs = JSON.stringify([created, await getDevice({ data: { orgId: device.orgId, id: created.id } }), await getDevices({ data: { orgId: device.orgId } })]);
  for (const secret of ["obs-fixture-secret", "private-header", "nested-token", "embedded-key"]) {
    expect(saved).not.toContain(secret);
    expect(outputs).not.toContain(secret);
  }
  expect(saved).toContain("spenc:v1:");
  expect(outputs).not.toContain("spenc:");
  expect(await readDeviceSettingsForUse(binding, { ...created, settings: saved })).toEqual(settings);
  expect(JSON.parse(created.settings)).toMatchObject({ host: settings.host, password: CREDENTIAL_MASK });
  await env.DB.prepare("UPDATE device SET settings=? WHERE id=? AND orgId=?").bind(JSON.stringify(settings), created.id, device.orgId).run();
  expect((await getDevice({ data: { orgId: device.orgId, id: created.id } }))?.settings).toBe(created.settings);
});

it("preserves omitted, blank and masked credentials, replaces explicitly and clears without a key", async () => {
  const device = await fixture();
  const created = await addDevice({ data: { orgId: device.orgId, name: "OBS", category: "streaming", adapterType: "obs", settings: JSON.stringify({ host: "10.0.0.1", password: "saved-secret" }) } });
  const before = await stored(created.id, device.orgId);
  for (const settings of [{ host: "10.0.0.2" }, { password: "" }, { password: CREDENTIAL_MASK }]) {
    await updateDevice({ data: { orgId: device.orgId, id: created.id, updates: { settings: JSON.stringify(settings) } } });
    const saved = await stored(created.id, device.orgId);
    expect(JSON.parse(saved).password).toBe(JSON.parse(before).password);
    expect((await readDeviceSettingsForUse(binding, { ...created, settings: saved })).password).toBe("saved-secret");
  }
  await updateDevice({ data: { orgId: device.orgId, id: created.id, updates: { settings: JSON.stringify({ password: "replacement" }) } } });
  expect((await readDeviceSettingsForUse(binding, { ...created, settings: await stored(created.id, device.orgId) })).password).toBe("replacement");
  env.CREDENTIAL_ENCRYPTION_KEYS = undefined;
  await updateDevice({ data: { orgId: device.orgId, id: created.id, updates: { name: "Keep without key" } } });
  await expect(updateDevice({ data: { orgId: device.orgId, id: created.id, updates: { settings: JSON.stringify({ password: "cannot-save" }) } } })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  await updateDevice({ data: { orgId: device.orgId, id: created.id, updates: {}, clearCredentials: [["password"]] } });
  expect(JSON.parse(await stored(created.id, device.orgId)).password).toBe("");
});

it("binds ciphertext to org, device and field and rejects caller ciphertext, masks without a saved value and implicit null clearing", async () => {
  const device = await fixture();
  const settings = await writeDeviceSettings(binding, device, JSON.stringify({ password: "fixture" }));
  for (const identity of [{ ...device, orgId: "other" }, { ...device, id: "other" }]) {
    await expect(readDeviceSettingsForUse(binding, { ...identity, settings })).rejects.toThrow("storage identity");
  }
  await expect(readDeviceSettingsForUse(binding, { ...device, settings: JSON.stringify({ authToken: JSON.parse(settings).password }) })).rejects.toThrow("storage identity");
  await expect(readDeviceSettingsForUse(undefined, { ...device, settings })).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  await expect(writeDeviceSettings(binding, device, settings)).rejects.toThrow("new credential");
  await expect(writeDeviceSettings(binding, device, JSON.stringify({ password: CREDENTIAL_MASK }))).rejects.toThrow("No saved credential");
  await expect(writeDeviceSettings(binding, device, JSON.stringify({ password: null }), settings)).rejects.toThrow("explicitly");
  expect(maskDeviceSettings({ ...device, settings: '{"password":"broken' })).toBe("{}");
  const nested = await writeDeviceSettings(binding, device, JSON.stringify({ rows: [{ token: "nested" }] }));
  await expect(writeDeviceSettings(binding, device, '{"rows":[]}', nested)).rejects.toThrow("explicitly");
  await expect(writeDeviceSettings(binding, device, '{"rows":null}', nested)).rejects.toThrow("explicitly");
});

it("encrypts the mobile create/edit path, masks mobile reads, and resolves the same saved credential for automation", async () => {
  const device = await fixture();
  async function request(path: string, body?: Record<string, unknown>) {
    const response = await handleMobileApi(new Request(`https://showpilot.test/api/mobile/v1/${path}?orgId=${device.orgId}`, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : undefined), { DB: env.DB, CREDENTIAL_ENCRYPTION_KEYS: binding });
    if (!response) throw new Error("Missing device route");
    return response;
  }
  const input = { name: "Mobile OBS", adapterType: "obs", enabled: true, settings: { host: "10.0.0.8", port: 4455, password: "mobile-secret" } };
  const created = await request("devices", input);
  expect(created.status).toBe(201);
  const { id } = await created.json<{ id: string }>();
  const before = await stored(id, device.orgId);
  expect(before).toContain("spenc:v1:");
  expect(before).not.toContain("mobile-secret");
  const listing = await (await request("devices")).text();
  expect(listing).not.toContain("mobile-secret");
  expect(listing).not.toContain("spenc:");
  expect(JSON.parse(listing).devices[0].configuration.find((field: { key: string }) => field.key === "password")).toMatchObject({ value: "", secretConfigured: true });
  const edited = await request(`devices/${id}`, { ...input, settings: { ...input.settings, password: "" } });
  expect(edited.status).toBe(200);
  expect(JSON.parse(await stored(id, device.orgId)).password).toBe(JSON.parse(before).password);
  const resolved = await resolveTimecodeDeviceAction(env.DB, device.orgId, {
    action: "device-action", targetDeviceId: id, targetActionId: "start_streaming", payload: {},
  }, binding);
  expect(resolved.connectionSettings.password).toBe("mobile-secret");
  expect(resolved.target).toBe("10.0.0.8:4455");
  const cleared = await request(`devices/${id}`, { ...input, settings: { ...input.settings, password: "" }, clearCredentials: [["password"]] });
  expect(cleared.status).toBe(200);
  expect(JSON.parse(await stored(id, device.orgId)).password).toBe("");
});

it("keeps credential types intact and starts adapter changes with clean settings", async () => {
  const device = await fixture();
  const input = { credentials: { user: "service", token: "secret" }, token: [1, "second"], password: true };
  const settings = await writeDeviceSettings(binding, device, JSON.stringify(input));
  expect(await readDeviceSettingsForUse(binding, { ...device, settings })).toEqual(input);
  const created = await addDevice({ data: { orgId: device.orgId, name: "Change adapter", category: "streaming", adapterType: "obs", settings: JSON.stringify({ password: "old-password", host: "old-host" }) } });
  await updateDevice({ data: { orgId: device.orgId, id: created.id, updates: { adapterType: "atem", settings: JSON.stringify({ host: "new-host" }) } } });
  expect(JSON.parse(await stored(created.id, device.orgId))).toEqual({ host: "new-host" });
});

it("rejects cross-organization device reads and writes before revealing any credential", async () => {
  const device = await fixture();
  const created = await addDevice({ data: { orgId: device.orgId, name: "Private", category: "streaming", adapterType: "obs", settings: JSON.stringify({ password: "private" }) } });
  await fixture();
  await expect(getDevices({ data: { orgId: device.orgId } })).rejects.toThrow("Forbidden");
  await expect(getDevice({ data: { orgId: device.orgId, id: created.id } })).rejects.toThrow("Forbidden");
  await expect(updateDevice({ data: { orgId: device.orgId, id: created.id, updates: {}, clearCredentials: [["password"]] } })).rejects.toThrow("Forbidden");
});

it("backfills bounded batches with CAS, revisits concurrent edits, and reports corrupt rows without echoing them", async () => {
  const device = await fixture();
  await env.DB.prepare("INSERT INTO device (id,orgId,name,category,adapterType,settings,updatedAt) VALUES (?,?,'Legacy','streaming','obs',?,CURRENT_TIMESTAMP)")
    .bind(device.id, device.orgId, JSON.stringify({ password: "legacy" })).run();
  const row = await env.DB.prepare("SELECT rowid AS rowId FROM device WHERE id=?").bind(device.id).first<number>("rowId");
  await env.DB.prepare("INSERT OR REPLACE INTO credential_backfill_cursor (name,lastRowId) VALUES ('devices',?)").bind(row! - 1).run();
  let raced = false;
  const raceDb = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!raced) {
        raced = true;
        await target.prepare("UPDATE device SET settings=? WHERE id=? AND orgId=?").bind(JSON.stringify({ password: "concurrent" }), device.id, device.orgId).run();
      }
      return target.batch<T>(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  expect((await backfillDeviceCredentials(raceDb, binding, 1)).migrated).toBe(0);
  expect(await stored(device.id, device.orgId)).toContain("concurrent");
  await env.DB.prepare("UPDATE credential_backfill_cursor SET lastRowId=? WHERE name='devices'").bind(row! - 1).run();
  expect((await backfillDeviceCredentials(env.DB, binding, 1)).migrated).toBe(1);
  expect(await readDeviceSettingsForUse(binding, { ...device, settings: await stored(device.id, device.orgId) })).toEqual({ password: "concurrent" });
  await env.DB.prepare("UPDATE device SET settings='broken' WHERE id=? AND orgId=?").bind(device.id, device.orgId).run();
  await env.DB.prepare("UPDATE credential_backfill_cursor SET lastRowId=? WHERE name='devices'").bind(row! - 1).run();
  expect(await backfillDeviceCredentials(env.DB, binding, 1)).toMatchObject({ invalid: 1, migrated: 0, scanned: 1 });
});


it("returns only scoped enabled action catalogs without device configuration or credentials", async () => {
  const mine = await fixture(); const other = await fixture();
  for (const [id, orgId, enabled] of [["mine", mine.orgId, 1], ["off", mine.orgId, 0], ["foreign", other.orgId, 1]] as const) {
    await env.DB.prepare("INSERT INTO device (id,orgId,name,adapterType,category,settings,enabled,createdAt,updatedAt) VALUES (?,?,?,'atem','video',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(`${mine.orgId}-${id}`, orgId, id, JSON.stringify({ host: "10.0.0.99", password: "fixture-private-password" }), enabled).run();
  }
  auth.userId = mine.userId;
  const catalog = await getAutomationDeviceTargets({ data: { orgId: mine.orgId } });
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toMatchObject({ id: `${mine.orgId}-mine`, label: "mine", category: "video", actions: expect.arrayContaining([expect.objectContaining({ id: "set_program_input", params: [expect.objectContaining({ id: "input", type: "number", min: 1, max: 20 })] })]) });
  const serialized = JSON.stringify(catalog);
  for (const hidden of ["settings", "password", "10.0.0.99", "fixture-private-password"]) expect(serialized).not.toContain(hidden);
  await expect(getAutomationDeviceTargets({ data: { orgId: other.orgId } })).rejects.toThrow("Forbidden");
});


it("includes disabled timeline device names but no foreign devices or configuration", async () => {
  const mine = await fixture(); const other = await fixture();
  for (const [name, orgId, enabled] of [["Active", mine.orgId, 1], ["Disabled", mine.orgId, 0], ["Foreign", other.orgId, 1]] as const) {
    await env.DB.prepare("INSERT INTO device (id,orgId,name,adapterType,category,settings,enabled,createdAt,updatedAt) VALUES (?,?,?,'atem','video',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(`${mine.orgId}-${name}`, orgId, name, JSON.stringify({ host: "10.0.0.99", password: "fixture-private-password" }), enabled).run();
  }
  auth.userId = mine.userId;
  expect(await getAutomationDeviceNames({ data: { orgId: mine.orgId } })).toEqual([
    { id: `${mine.orgId}-Active`, label: "Active", enabled: true },
    { id: `${mine.orgId}-Disabled`, label: "Disabled", enabled: false },
  ]);
  await expect(getAutomationDeviceNames({ data: { orgId: other.orgId } })).rejects.toThrow("Forbidden");
});
