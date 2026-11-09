// Worker -> native settings transport. The authenticated WebSocket supplies the
// native process's ephemeral public key; its private key never leaves memory.
const VERSION = 1;
const LIFETIME = 30_000;
export const MAX_BRIDGE_SETTINGS_BYTES = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const failure = () => new Error("Protected Bridge settings are invalid, expired or unavailable.");
const record = value => typeof value === "object" && value !== null && !Array.isArray(value);
function bytes(value, max, exact) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure();
  let raw;
  try { raw = Uint8Array.from(atob(value), character => character.charCodeAt(0)); } catch { throw failure(); }
  if (raw.length > max || exact !== undefined && raw.length !== exact || base64(raw) !== value) throw failure();
  return raw;
}
function base64(value) {
  const data = new Uint8Array(value);
  let text = "";
  for (let offset = 0; offset < data.length; offset += 8192) text += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(text);
}
function binding(value) {
  if (!record(value)) throw failure();
  const result = {};
  for (const [key, limit] of [["orgId", 200], ["installationId", 200], ["protocol", 64], ["target", 2048]]) {
    if (typeof value[key] !== "string" || !value[key] || value[key].length > limit) throw failure();
    result[key] = value[key];
  }
  return result;
}
function aad(context, envelope) {
  return encoder.encode(JSON.stringify(["showpilot-bridge-settings", VERSION, binding(context), envelope.keyId, envelope.nonce, envelope.expiresAt]));
}
export async function importBridgeSettingsKey(encoded) {
  try {
    const raw = bytes(encoded, 512);
    const key = await crypto.subtle.importKey("spki", raw, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    if (key.algorithm.modulusLength !== 2048 || base64(key.algorithm.publicExponent) !== "AQAB") throw failure();
    return { key, keyId: base64(await crypto.subtle.digest("SHA-256", raw)) };
  } catch { throw failure(); }
}
export async function sealBridgeSettings(recipient, context, settings) {
  let rawKey;
  let plaintext;
  try {
    if (!record(settings)) throw failure();
    plaintext = encoder.encode(JSON.stringify(settings));
    if (plaintext.byteLength > MAX_BRIDGE_SETTINGS_BYTES) throw failure();
    const { key, keyId } = await importBridgeSettingsKey(recipient);
    const envelope = { version: VERSION, keyId, nonce: crypto.randomUUID(), expiresAt: Date.now() + LIFETIME };
    rawKey = crypto.getRandomValues(new Uint8Array(32));
    const dataKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = aad(context, envelope);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, dataKey, plaintext);
    const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, rawKey);
    return { ...envelope, iv: base64(iv), wrappedKey: base64(wrappedKey), ciphertext: base64(ciphertext) };
  } catch { throw failure(); }
  finally { rawKey?.fill(0); plaintext?.fill(0); }
}
export async function createBridgeSettingsRecipient() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["encrypt", "decrypt"]);
  const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
  const publicKey = base64(publicBytes);
  const keyId = base64(await crypto.subtle.digest("SHA-256", publicBytes));
  const consumed = new Map();
  return {
    publicKey,
    async open(value, context) {
      let rawKey;
      let plaintext;
      try {
        const now = Date.now();
        if (!record(value) || value.version !== VERSION || value.keyId !== keyId
          || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(value.nonce)
          || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + LIFETIME + 5000) throw failure();
        for (const [nonce, expiresAt] of consumed) if (expiresAt <= now) consumed.delete(nonce);
        if (consumed.has(value.nonce) || consumed.size >= 256) throw failure();
        const iv = bytes(value.iv, 12, 12);
        const wrappedKey = bytes(value.wrappedKey, 256, 256);
        const ciphertext = bytes(value.ciphertext, MAX_BRIDGE_SETTINGS_BYTES + 16);
        const additionalData = aad(context, value);
        rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, wrappedKey));
        if (rawKey.length !== 32) throw failure();
        const dataKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, dataKey, ciphertext));
        const settings = JSON.parse(decoder.decode(plaintext));
        if (!record(settings) || consumed.has(value.nonce) || value.expiresAt <= Date.now()) throw failure();
        consumed.set(value.nonce, value.expiresAt);
        return settings;
      } catch { throw failure(); }
      finally { rawKey?.fill(0); plaintext?.fill(0); }
    },
  };
}
