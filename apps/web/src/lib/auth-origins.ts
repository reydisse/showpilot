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
 * Credentialed browser requests may come from ShowPilot's HTTPS origins. LAN
 * origins are accepted only when the API endpoint is also local development;
 * a production Worker must never trust an arbitrary site on the user's LAN.
 */
export function isAllowedApiOrigin(origin: string | null, apiUrl: string): boolean {
  if (!origin) return false;

  let parsedOrigin: URL;
  let parsedApi: URL;
  try {
    parsedOrigin = new URL(origin);
    parsedApi = new URL(apiUrl);
  } catch {
    return false;
  }

  const originHost = parsedOrigin.hostname.toLowerCase();
  const isShowPilotOrigin = parsedOrigin.protocol === "https:" && (
    originHost === "showpilot.tech" ||
    originHost.endsWith(".showpilot.tech") ||
    originHost === "showpilot.reydisse.workers.dev"
  );
  if (isShowPilotOrigin) return true;

  return (
    parsedOrigin.protocol === "http:" &&
    parsedApi.protocol === "http:" &&
    isLocalDevelopmentHost(originHost) &&
    isLocalDevelopmentHost(parsedApi.hostname.toLowerCase())
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

  // Better Auth supports a wildcard port. Keep the host exact and derive it
  // only from an explicitly local base URL, so parallel Metro/Vite servers
  // remain testable without widening the production origin allowlist.
  return [url.origin, `http://${url.hostname}:*`];
}
