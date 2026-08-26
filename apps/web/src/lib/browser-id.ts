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
