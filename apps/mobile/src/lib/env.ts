const configuredUrl = process.env.EXPO_PUBLIC_SHOWPILOT_URL?.trim();
const productionUrl = "https://showpilot.tech";
const resolvedUrl = configuredUrl && (__DEV__ || configuredUrl.startsWith("https://"))
  ? configuredUrl
  : productionUrl;

// A Release build must never depend on a developer's LAN address. Local HTTP
// backends remain available to Metro builds, while signed builds fail safe to
// the production service.
export const SHOWPILOT_URL = resolvedUrl.replace(/\/$/, "");
