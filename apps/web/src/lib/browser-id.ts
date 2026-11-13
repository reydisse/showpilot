interface BrowserCrypto {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint32Array) => Uint32Array;
}

/**
 * `crypto.randomUUID` is restricted to secure browser contexts. ShowPilot's
 * LAN development and venue QA origins use HTTP, where `getRandomValues`
 * remains available and still gives command IDs enough entropy for dedupe.
 */
export function createBrowserId(
  source: BrowserCrypto | undefined = globalThis.crypto,
): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  if (typeof source?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    source.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36)).join("-");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** UUID-shaped correlation IDs for APIs that validate request receipts, including
 * LAN origins where randomUUID is unavailable. These are not credentials. */
export function createBrowserRequestId(source: BrowserCrypto | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const words = new Uint32Array(4);
  if (source?.getRandomValues) source.getRandomValues(words);
  else for (let index = 0; index < words.length; index++) words[index] = Math.floor(Math.random() * 0x100000000);
  const hex = Array.from(words, word => word.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
