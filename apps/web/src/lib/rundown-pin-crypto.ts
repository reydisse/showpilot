import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HASH_PREFIX = "pbkdf2-sha256";
const HASH_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derivePin(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  // Workers caps Web Crypto PBKDF2 at 100,000 iterations. Use the portable
  // implementation to retain the existing work factor and stored PIN hashes.
  return pbkdf2(sha256, pin, salt, { c: iterations, dkLen: DERIVED_KEY_BYTES });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function isHashedRundownPin(value: string): boolean {
  return value.startsWith(`${HASH_PREFIX}:`);
}

export async function hashRundownPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derivePin(pin, salt, HASH_ITERATIONS);
  return [
    HASH_PREFIX,
    String(HASH_ITERATIONS),
    encodeBase64Url(salt),
    encodeBase64Url(derived),
  ].join(":");
}

export async function verifyStoredRundownPin(
  presentedPin: string | null,
  storedValue: string | null | undefined,
): Promise<boolean> {
  const stored = storedValue?.trim();
  if (!stored) return true;
  if (!presentedPin) return false;

  if (!isHashedRundownPin(stored)) {
    return presentedPin === stored;
  }

  const [prefix, iterationsText, saltText, expectedText, extra] = stored.split(":");
  if (prefix !== HASH_PREFIX || extra !== undefined) return false;

  const iterations = Number(iterationsText);
  const salt = decodeBase64Url(saltText);
  const expected = decodeBase64Url(expectedText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > HASH_ITERATIONS
    || salt?.length !== SALT_BYTES || expected?.length !== DERIVED_KEY_BYTES) {
    return false;
  }

  const actual = await derivePin(presentedPin, salt, iterations);
  return equalBytes(actual, expected);
}
