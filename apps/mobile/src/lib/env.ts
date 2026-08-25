const configuredUrl = process.env.EXPO_PUBLIC_SHOWPILOT_URL?.trim();

export const SHOWPILOT_URL = (configuredUrl || "https://showpilot.tech").replace(/\/$/, "");
