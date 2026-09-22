const HASH_PREFIX = "pbkdf2-sha256";
const HASH_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

const encoder = new TextEncoder();

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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function derivePin(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    key,
    DERIVED_KEY_BITS,
  );
  return new Uint8Array(bits);
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
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || !salt || !expected) {
    return false;
  }

  const actual = await derivePin(presentedPin, salt, iterations);
  return equalBytes(actual, expected);
}
