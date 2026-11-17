/** Only allow public HTTPS destinations for server-side automation webhooks. */
export function isSafeAutomationWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1") return false;
    if (host.includes(":") || /^[\d.]+$/.test(host)) return isPublicIpAddress(host.replace(/^\[|\]$/g, ""));
    return Boolean(host);
  } catch {
    return false;
  }
}

/** Classify an IP literal without performing network I/O. */
export function isPublicIpAddress(address: string): boolean {
  if (address.includes(":")) {
    let host: string;
    try { host = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return false; }
    const halves = host.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const words = (halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill("0"), ...right] : left).map(x => parseInt(x,16));
    if (words.length !== 8) return false;
    if (words.slice(0,5).every(x => x === 0) && words[5] === 65535) return isPublicIpAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    return !(words.every(x => x === 0) || (words.slice(0,7).every(x => x === 0) && words[7] === 1) || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xff00) === 0xff00 || (words[0] === 0x2001 && words[1] === 0xdb8));
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  const [a,b,c,d] = address.split(".").map(Number);
  if ([a,b,c,d].some(x => x > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
