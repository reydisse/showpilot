import "./device-modules/register-all";
import { moduleRegistry } from "./device-modules/registry";
import { CREDENTIAL_MASK, isCredentialField } from "./credential-fields";
import { CredentialVault } from "./credential-vault.server";
import { markDatabaseWrite } from "./request-database.server";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Settings = { [key: string]: Json };
export interface DeviceSettingsIdentity { orgId: string; id: string; adapterType: string }
type StoredDevice = DeviceSettingsIdentity & { settings: string };

function object(value: Json | undefined): value is Settings {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(value: string): Settings {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Settings; // JSON.parse establishes the recursive JSON value boundary.
  } catch { throw new Error("Device settings must be a JSON object."); }
}

function structured(value: Json): Json | undefined {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return undefined;
  try { return JSON.parse(value) as Json; } catch { return undefined; }
}

function credentialAt(device: DeviceSettingsIdentity, path: readonly string[]): boolean {
  const key = path.at(-1) ?? "";
  return isCredentialField(key) || (path.length === 1 && Boolean(moduleRegistry.get(device.adapterType)?.configFields
    .some(field => field.key === key && field.type === "password")));
}

function sealed(value: Json | undefined): value is `spenc:${string}` {
  return typeof value === "string" && value.startsWith("spenc:");
}

/** Public reads include configured status only, including legacy plaintext rows. */
export function maskDeviceSettings(device: StoredDevice): string {
  function visit(value: Json, path: string[]): Json {
    if (path.length > 16) throw new Error("Device settings are nested too deeply.");
    if (sealed(value) || (credentialAt(device, path) && value !== "" && value !== null)) return CREDENTIAL_MASK;
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, String(index)]));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
    const nested = structured(value);
    return nested === undefined ? value : JSON.stringify(visit(nested, [...path, "$json"]));
  }
  // Corrupt legacy rows must never be echoed, even on an unrelated read.
  try { return JSON.stringify(visit(parse(device.settings), [])); }
  catch { return "{}"; }
}

/** Permission-checked writers only. Omitted/blank/masked credentials keep the saved
 * value. Removal is explicit; caller-supplied ciphertext is never accepted. */
export async function writeDeviceSettings(
  secret: string | undefined,
  device: DeviceSettingsIdentity,
  input: string,
  previous = "{}",
  clearCredentials: readonly (readonly string[])[] = [],
): Promise<string> {
  const incoming = parse(input);
  const existing = parse(previous);
  const clears = new Set(clearCredentials.map(path => JSON.stringify(path)));
  const consumed = new Set<string>();
  let vault: Promise<CredentialVault> | undefined;
  function validate(value: Json, depth = 0): void {
    if (depth > 16) throw new Error("Device settings are nested too deeply.");
    if (sealed(value)) throw new Error("Supply a new credential or keep the saved value.");
    if (Array.isArray(value)) value.forEach(item => validate(item, depth + 1));
    else if (object(value)) Object.values(value).forEach(item => validate(item, depth + 1));
    else {
      const nested = structured(value);
      if (nested !== undefined) validate(nested, depth + 1);
    }
  }
  validate(incoming);
  function containsCredential(value: Json | undefined, path: string[]): boolean {
    if (value === undefined || value === null || value === "") return false;
    if (path.length > 16) throw new Error("Device settings are nested too deeply.");
    if (credentialAt(device, path) || sealed(value)) return true;
    if (Array.isArray(value)) return value.some((item, index) => containsCredential(item, [...path, String(index)]));
    if (object(value)) return Object.entries(value).some(([key, item]) => containsCredential(item, [...path, key]));
    const nested = structured(value);
    return nested !== undefined && containsCredential(nested, [...path, "$json"]);
  }
  async function visit(next: Json | undefined, old: Json | undefined, path: string[]): Promise<Json> {
    if (path.length > 16) throw new Error("Device settings are nested too deeply.");
    const sensitive = credentialAt(device, path) || sealed(old);
    const pathKey = JSON.stringify(path);
    if (clears.has(pathKey)) {
      if (!sensitive) throw new Error("Only credential fields can be cleared this way.");
      consumed.add(pathKey);
      return "";
    }
    if (sensitive) {
      const keep = next === undefined || next === "" || next === CREDENTIAL_MASK;
      if (next === CREDENTIAL_MASK && (old === undefined || old === "" || old === null)) throw new Error("No saved credential exists to keep.");
      if (next === null && old !== undefined && old !== "" && old !== null) throw new Error("Confirm credential removal explicitly.");
      const value = keep ? old : next;
      if (value === undefined || value === "" || value === null) return "";
      if (keep && sealed(value)) return value;
      vault ??= CredentialVault.fromSecret(secret);
      return await (await vault).encrypt({ kind: "device", orgId: device.orgId, deviceId: device.id, path }, JSON.stringify(value));
    }
    if (next === CREDENTIAL_MASK) throw new Error("No saved credential exists to keep.");
    const value = next === undefined ? old : next;
    if (value === undefined) return null;
    // Replacing a parent or truncating an array must not silently erase a secret.
    if (next !== undefined && containsCredential(old, path)) {
      const replacesContainer = (object(old) && !object(next)) || (Array.isArray(old) && !Array.isArray(next))
        || (typeof old === "string" && structured(old) !== undefined && structured(next) === undefined);
      const dropsArraySecrets = Array.isArray(old) && Array.isArray(next) && old.slice(next.length)
        .some((item, index) => containsCredential(item, [...path, String(next.length + index)]));
      if (replacesContainer || dropsArraySecrets) throw new Error("Clear nested credentials explicitly before replacing their container.");
    }
    if (Array.isArray(value)) return await Promise.all(value.map((item, index) => visit(
      next === undefined ? undefined : item, Array.isArray(old) ? old[index] : undefined, [...path, String(index)],
    )));
    if (object(value)) {
      const previousObject = object(old) ? old : {};
      const supplied = object(next) ? next : {};
      const keys = new Set([...Object.keys(previousObject), ...Object.keys(value)]);
      return Object.fromEntries(await Promise.all([...keys].map(async key => [key, await visit(
        Object.hasOwn(supplied, key) ? supplied[key] : undefined,
        Object.hasOwn(previousObject, key) ? previousObject[key] : undefined,
        [...path, key],
      )])));
    }
    const nested = structured(value);
    if (nested !== undefined) return JSON.stringify(await visit(next === undefined ? undefined : nested,
      old === undefined ? undefined : structured(old), [...path, "$json"]));
    return value;
  }
  const result = JSON.stringify(await visit(incoming, existing, []));
  if (consumed.size !== clears.size) throw new Error("Choose an existing credential field to clear.");
  return result;
}

/** Internal device control only, after org permission checks. Never return this object to clients. */
export async function readDeviceSettingsForUse(secret: string | undefined, device: StoredDevice): Promise<Record<string, unknown>> {
  let vault: Promise<CredentialVault> | undefined;
  async function visit(value: Json, path: string[]): Promise<Json> {
    if (path.length > 16) throw new Error("Device settings are nested too deeply.");
    if (sealed(value)) {
      vault ??= CredentialVault.fromSecret(secret);
      const plaintext = await (await vault).decrypt({ kind: "device", orgId: device.orgId, deviceId: device.id, path }, value);
      return JSON.parse(plaintext) as Json;
    }
    if (Array.isArray(value)) return await Promise.all(value.map((item, index) => visit(item, [...path, String(index)])));
    if (object(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await visit(item, [...path, key])])));
    const nested = structured(value);
    return nested === undefined ? value : JSON.stringify(await visit(nested, [...path, "$json"]));
  }
  const result = await visit(parse(device.settings), []);
  if (!object(result)) throw new Error("Device settings must be a JSON object.");
  return result;
}

/** Bounded CAS migration; concurrent edits are revisited on the next complete sweep. */
export async function backfillDeviceCredentials(db: D1Database, secret: string | undefined, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid credential migration batch size");
  await CredentialVault.fromSecret(secret);
  await db.prepare("INSERT OR IGNORE INTO credential_backfill_cursor (name,lastRowId) VALUES ('devices',0)").run();
  const cursor = await db.prepare("SELECT lastRowId FROM credential_backfill_cursor WHERE name='devices'").first<number>("lastRowId") ?? 0;
  const rows = (await db.prepare("SELECT rowid AS rowId,id,orgId,adapterType,settings FROM device WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .bind(cursor, limit).all<StoredDevice & { rowId: number }>()).results;
  const updates: D1PreparedStatement[] = [];
  let invalid = 0;
  for (const row of rows) {
    try {
      const settings = await writeDeviceSettings(secret, row, "{}", row.settings);
      if (settings !== row.settings) updates.push(db.prepare("UPDATE device SET settings=? WHERE id=? AND orgId=? AND adapterType=? AND settings=?")
        .bind(settings, row.id, row.orgId, row.adapterType, row.settings));
    } catch { invalid++; } // Corrupt rows remain masked; report them without recording their contents.
  }
  const next = rows.length < limit ? 0 : rows[rows.length - 1].rowId;
  const results = await db.batch([...updates, db.prepare("UPDATE credential_backfill_cursor SET lastRowId=? WHERE name='devices' AND lastRowId=?").bind(next, cursor)]);
  const migrated = results.slice(0, -1).reduce((sum, result) => sum + result.meta.changes, 0);
  if (migrated) markDatabaseWrite();
  return { scanned: rows.length, migrated, invalid, sweepComplete: next === 0 };
}
