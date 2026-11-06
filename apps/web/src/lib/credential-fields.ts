/** Public read responses report configuration without disclosing its value. */
export const CREDENTIAL_MASK = "••••••••";

// These URLs carry bearer authority in their path, even without an auth field.
const credentialUrlKeys = new Set(["webhookurl", "teamswebhookurl", "discordwebhookurl"]);
const credentialNames = new Set([
  "password", "passwd", "passphrase", "secret", "token", "apikey", "authkey",
  "auth", "privatekey", "authorization", "proxyauthorization", "cookie", "setcookie", "credential", "credentials",
]);

/** Used at settings/device boundaries, including nested custom headers. */
export function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return credentialUrlKeys.has(normalized) || credentialNames.has(normalized)
    || /(?:password|passwd|passphrase|secret|token|apikey|authkey)$/.test(normalized);
}

export function maskedCredential(value: string): string {
  return value ? CREDENTIAL_MASK : "";
}

export type CredentialChange =
  | { action: "keep" }
  | { action: "replace"; value: string }
  | { action: "clear" };

/** Device protocols may return JSON inside a string. Keep display text intact,
 * but apply the same credential policy to structured replies and nested blobs. */
export function redactCredentialText(text: string): string {
  const value = text.trim();
  if (value.startsWith("spenc:")) return CREDENTIAL_MASK;
  if (!value.startsWith("{") && !value.startsWith("[")) return text;
  return redactStructuredText(text, 0);
}

function redactStructuredText(text: string, depth: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const redacted = JSON.stringify(redactCredentialPayload(parsed, depth));
    // Preserve exact formatting and numeric spelling when nothing was removed.
    return redacted === JSON.stringify(parsed) ? text : redacted;
  } catch { return "[Unreadable structured device response]"; }
}

export function redactCredentialPayload(value: unknown, depth = 0): unknown {
  if (depth > 16) return CREDENTIAL_MASK;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("spenc:")) return CREDENTIAL_MASK;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return redactStructuredText(value, depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactCredentialPayload(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isCredentialField(key) && item !== "" && item !== null ? CREDENTIAL_MASK : redactCredentialPayload(item, depth + 1),
    ]));
  }
  return value;
}
