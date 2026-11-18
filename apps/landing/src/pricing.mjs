// Landing marketing prices; billing and enforcement are managed separately.
export const PRICING = {
  starter: {
    name: "Basic",
    monthly: 39.99,
    tagline: "The essentials for one service in one space",
    features: [
      "One space",
      "Rundowns",
      "Show clock &amp; timers",
      "Crew check-in",
      "Production chat",
    ],
  },
  pro: {
    name: "Pro",
    monthly: 79.99,
    tagline: "The full feature set, across unlimited spaces",
    features: [
      "Unlimited spaces",
      "Everything in Basic",
      "Bridge &amp; device integrations",
      "Cue sheets &amp; checklists",
      "Incidents",
      "Songs &amp; service planning",
      "Graphics &amp; kiosk displays",
      "Templates",
      "Webhooks",
      "Advanced permissions",
    ],
  },
  annualNote: "Pay yearly and get 12 months for the price of 10",
};

export const APP_URL = "https://app.showpilot.tech";
export const SIGNUP_URL = `${APP_URL}/login?signup=1`;
export const LOGIN_URL = `${APP_URL}/login`;
export const SUPPORT_EMAIL = "support@showpilot.tech";
