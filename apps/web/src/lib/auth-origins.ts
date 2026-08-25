const DEVELOPMENT_PORTS = [3000, 3001, 5173, 8081] as const;

export function isLocalDevelopmentHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;

  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/**
 * Better Auth must trust Metro's web origin during LAN QA. Only derive these
 * origins from an explicitly configured, non-public HTTP development host.
 */
export function getDevelopmentTrustedOrigins(baseURL: string): string[] {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return [];
  }

  if (url.protocol !== "http:" || !isLocalDevelopmentHost(url.hostname)) return [];

  return [...new Set([
    url.origin,
    ...DEVELOPMENT_PORTS.map((port) => `http://${url.hostname}:${port}`),
  ])];
}
