// Landing marketing prices; billing and enforcement are managed separately.
export const PRICING = {
  starter: {
    name: "Starter",
    monthly: 39.99,
    tagline: "For one room, with the full core feature set",
    features: ["Show planning", "Team collaboration", "All integrations", "Kiosk displays"],
  },
  pro: {
    name: "Pro",
    monthly: 79.99,
    tagline: "For unlimited rooms, with an advanced feature layer",
    features: ["Show planning", "Team collaboration", "All integrations", "Kiosk displays"],
  },
  annualNote: "Annual billing available — 2 months free",
};

export const APP_URL = "https://app.showpilot.tech";
export const SIGNUP_URL = `${APP_URL}/login?signup=1`;
export const LOGIN_URL = `${APP_URL}/login`;
export const SUPPORT_EMAIL = "support@showpilot.tech";
