import { z } from "zod";
import { CREDENTIAL_MASK, type CredentialChange } from "./credential-fields";

const PREFIX = "spenc:v1:";
const MAX_VALUE_BYTES = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const keyringSchema = z.object({
  active: keyIdSchema,
  keys: z.record(keyIdSchema, z.string()),
}).strict();
const envelopeSchema = z.object({
  keyId: keyIdSchema,
  wrapIv: z.string(),
  wrappedKey: z.string(),
  valueIv: z.string(),
  ciphertext: z.string(),
}).strict();

export type CredentialScope =
  | { kind: "setting"; orgId: string; key: string }
  | { kind: "device"; orgId: string; deviceId: string; path: readonly string[] }
  | { kind: "stream-destination"; orgId: string; destinationId: string };

export class CredentialVaultError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialVaultError"; }
}

function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid base64");
  const decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (encodeBase64(decoded) !== value) throw new Error("Noncanonical base64");
  return decoded;
}
function additionalData(scope: CredentialScope, purpose: "key" | "value", keyId: string): Uint8Array<ArrayBuffer> {
  let identity: readonly (string | readonly string[])[];
  switch (scope.kind) {
    case "setting": identity = [scope.key]; break;
    case "device": identity = [scope.deviceId, scope.path]; break;
    case "stream-destination": identity = [scope.destinationId, "streamKey"]; break;
  }
  if (!scope.orgId || identity.some(part => typeof part === "string" ? !part : !part.length || part.some(value => !value))) {
    throw new CredentialVaultError("Credential storage identity is missing.");
  }
  return encoder.encode(JSON.stringify([
    "showpilot-credential", 1, purpose, keyId, scope.kind, scope.orgId,
    ...identity,
  ]));
}

export function isEncryptedCredential(value: string): boolean { return value.startsWith(PREFIX); }

/** One fresh data key per value; only the wrapping keys live in Workers secrets.
 * Callers provide CREDENTIAL_ENCRYPTION_KEYS from the Worker environment. */
export class CredentialVault {
  private constructor(private readonly active: string, private readonly keys: ReadonlyMap<string, CryptoKey>) {}

  static async fromSecret(secret: string | undefined): Promise<CredentialVault> {
    try {
      if (!secret || secret.length > 16_384) throw new Error("Missing keyring");
      const configuration = keyringSchema.parse(JSON.parse(secret));
      const entries = Object.entries(configuration.keys);
      if (!entries.length || entries.length > 16 || !Object.hasOwn(configuration.keys, configuration.active)) throw new Error("Invalid keyring");
      const keys = new Map<string, CryptoKey>();
      for (const [id, encoded] of entries) {
        const bytes = decodeBase64(encoded);
        if (bytes.byteLength !== 32) throw new Error("Invalid key length");
        try { keys.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])); }
        finally { bytes.fill(0); }
      }
      return new CredentialVault(configuration.active, keys);
    } catch {
      // Neither configured material nor parser details belong in logs/responses.
      throw new CredentialVaultError("Credential encryption is unavailable. Configure CREDENTIAL_ENCRYPTION_KEYS.");
    }
  }

  async encrypt(scope: CredentialScope, plaintext: string): Promise<string> {
    if (!plaintext || plaintext === CREDENTIAL_MASK || plaintext.startsWith("spenc:")) {
      throw new CredentialVaultError("Enter a new credential value or explicitly clear it.");
    }
    const value = encoder.encode(plaintext);
    if (value.byteLength > MAX_VALUE_BYTES) throw new CredentialVaultError("Credential value is too large.");
    const valueAad = additionalData(scope, "value", this.active);
    const keyAad = additionalData(scope, "key", this.active);
    const wrappingKey = this.keys.get(this.active);
    if (!wrappingKey) throw new CredentialVaultError("Credential encryption key is unavailable.");
    const rawDataKey = crypto.getRandomValues(new Uint8Array(32));
    const valueIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    try {
      const dataKey = await crypto.subtle.importKey("raw", rawDataKey, "AES-GCM", false, ["encrypt"]);
      const [ciphertext, wrappedKey] = await Promise.all([
        crypto.subtle.encrypt({ name: "AES-GCM", iv: valueIv, additionalData: valueAad, tagLength: 128 }, dataKey, value),
        crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: keyAad, tagLength: 128 }, wrappingKey, rawDataKey),
      ]);
      return PREFIX + encodeBase64(encoder.encode(JSON.stringify({
        keyId: this.active,
        wrapIv: encodeBase64(wrapIv), wrappedKey: encodeBase64(new Uint8Array(wrappedKey)),
        valueIv: encodeBase64(valueIv), ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      })));
    } finally { rawDataKey.fill(0); value.fill(0); }
  }

  async decrypt(scope: CredentialScope, stored: string): Promise<string> {
    try {
      if (!isEncryptedCredential(stored) || stored.length > 400_000) throw new Error("Invalid envelope");
      const envelope = envelopeSchema.parse(JSON.parse(decoder.decode(decodeBase64(stored.slice(PREFIX.length)))));
      const wrappingKey = this.keys.get(envelope.keyId);
      if (!wrappingKey) throw new Error("Unknown key");
      const wrapIv = decodeBase64(envelope.wrapIv);
      const valueIv = decodeBase64(envelope.valueIv);
      const wrappedKey = decodeBase64(envelope.wrappedKey);
      const ciphertext = decodeBase64(envelope.ciphertext);
      if (wrapIv.length !== 12 || valueIv.length !== 12 || wrappedKey.length !== 48 || ciphertext.length < 17 || ciphertext.length > MAX_VALUE_BYTES + 16) throw new Error("Invalid envelope length");
      const rawDataKey = new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM", iv: wrapIv, additionalData: additionalData(scope, "key", envelope.keyId), tagLength: 128,
      }, wrappingKey, wrappedKey));
      try {
        const dataKey = await crypto.subtle.importKey("raw", rawDataKey, "AES-GCM", false, ["decrypt"]);
        const value = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM", iv: valueIv, additionalData: additionalData(scope, "value", envelope.keyId), tagLength: 128,
        }, dataKey, ciphertext));
        try { return decoder.decode(value); } finally { value.fill(0); }
      } finally { rawDataKey.fill(0); }
    } catch {
      throw new CredentialVaultError("Stored credential could not be decrypted. Check its encryption key and storage identity.");
    }
  }

  /** Existing keys remain readable while old wrapping keys are in the keyring. */
  async reencrypt(scope: CredentialScope, stored: string): Promise<string> {
    return await this.encrypt(scope, await this.decrypt(scope, stored));
  }

  async applyChange(scope: CredentialScope, stored: string | null, change: CredentialChange): Promise<string> {
    switch (change.action) {
      case "clear": return "";
      case "replace": return await this.encrypt(scope, change.value);
      case "keep":
        if (!stored) return "";
        if (stored.startsWith("spenc:")) {
          await this.decrypt(scope, stored); // Never preserve an unreadable or moved value silently.
          return stored;
        }
        return await this.encrypt(scope, stored);
    }
  }
}
