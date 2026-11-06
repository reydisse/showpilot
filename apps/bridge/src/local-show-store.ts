import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  deleteCredential,
  readCredential,
  writeCredential,
} from "./credential-store.js";

const FORMAT = "showpilot-local-show-v1";
const MAX_BYTES = 8 * 1024 * 1024;
const STORE_ERROR =
  "The local show could not be saved securely. Unlock the system keychain and check available disk space.";
const READ_ERROR =
  "The saved local show could not be verified. Keep the cache and reconnect to prepare a new copy.";

interface Envelope {
  format: typeof FORMAT;
  keyReference: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class LocalShowStoreError extends Error {
  constructor(readonly committed: boolean) {
    super(STORE_ERROR);
  }
}
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || value.length > MAX_BYTES * 2)
    throw new Error(READ_ERROR);
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (length !== undefined && decoded.length !== length)
  )
    throw new Error(READ_ERROR);
  return decoded;
}
function envelope(value: unknown): Envelope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("format" in value) ||
    value.format !== FORMAT ||
    !("keyReference" in value) ||
    typeof value.keyReference !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.keyReference) ||
    !("iv" in value) ||
    typeof value.iv !== "string" ||
    !("tag" in value) ||
    typeof value.tag !== "string" ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string"
  )
    throw new Error(READ_ERROR);
  return {
    format: FORMAT,
    keyReference: value.keyReference,
    iv: value.iv,
    tag: value.tag,
    ciphertext: value.ciphertext,
  };
}

/** One sidecar owns this file. Device passwords stay encrypted on disk; the
 * random AES key lives in the existing OS credential store, never beside it.
 */
export class LocalShowStore {
  private key: { reference: string; value: Buffer } | null = null;
  constructor(private readonly file: string) {}

  load(): unknown | null {
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile() || stat.size > MAX_BYTES * 2)
        throw new Error(READ_ERROR);
      const saved = envelope(JSON.parse(fs.readFileSync(this.file, "utf8")));
      const key = bytes(readCredential(saved.keyReference), 32);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes(saved.iv, 12),
      );
      decipher.setAAD(Buffer.from(`${FORMAT}:${saved.keyReference}`));
      decipher.setAuthTag(bytes(saved.tag, 16));
      const plaintext = Buffer.concat([
        decipher.update(bytes(saved.ciphertext)),
        decipher.final(),
      ]);
      if (plaintext.length > MAX_BYTES) throw new Error(READ_ERROR);
      const value: unknown = JSON.parse(plaintext.toString("utf8"));
      this.key = { reference: saved.keyReference, value: key };
      return value;
    } catch {
      throw new Error(READ_ERROR);
    }
  }

  save(value: unknown): void {
    let temporary: string | undefined;
    let newKey = false;
    let committed = false;
    try {
      const plaintext = Buffer.from(JSON.stringify(value), "utf8");
      if (plaintext.length > MAX_BYTES) throw new Error(STORE_ERROR);
      if (!this.key && fs.existsSync(this.file)) this.load();
      if (!this.key) {
        const reference = randomUUID();
        const key = randomBytes(32);
        writeCredential(reference, key.toString("base64"));
        this.key = { reference, value: key };
        newKey = true;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key.value, iv);
      cipher.setAAD(Buffer.from(`${FORMAT}:${this.key.reference}`));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const saved: Envelope = {
        format: FORMAT,
        keyReference: this.key.reference,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      const directory = path.dirname(this.file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporary = path.join(directory, `.local-show-${randomUUID()}.tmp`);
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(saved));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
      temporary = undefined;
      committed = true;
      // The key now belongs to a committed file even if the directory flush fails.
      newKey = false;
      if (process.platform !== "win32") {
        const directoryHandle = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(directoryHandle);
        } finally {
          fs.closeSync(directoryHandle);
        }
      }
    } catch {
      if (newKey && this.key) {
        try {
          deleteCredential(this.key.reference);
        } catch {
          /* Unreferenced key contains no show data. */
        }
        this.key = null;
      }
      throw new LocalShowStoreError(committed);
    } finally {
      if (temporary) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* Ciphertext orphan only. */
        }
      }
    }
  }
}
