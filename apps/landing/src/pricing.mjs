// Single source of truth for every price shown on the landing page.
// The build script (build.mjs) interpolates these into the HTML template —
// no price is ever hardcoded in markup. Keep in sync with the app's plan
// cards (apps/web/src/routes/$slug/settings.tsx) and Stripe prices
// (STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_FOUNDING).

export const PRICING = {
  starter: {
    name: "Starter",
    monthly: 39,
    tagline: "For small teams running weekly shows",
    features: [
      "25 team members",
      "10 devices",
      "50 shows",
      "All integrations",
      "Kiosk displays",
    ],
  },
  pro: {
    name: "Pro",
    monthly: 79,
    tagline: "Full production power, no ceilings",
    features: [
      "100 team members",
      "Unlimited devices",
      "Unlimited shows",
      "All integrations",
      "Kiosk displays",
    ],
  },
  founding: {
    name: "Founding Member",
    monthly: 25,
    tagline: "Everything in Pro, locked in for life",
  },
  // Annual prices are not created in Stripe yet — shown as coming soon.
  annualNote: "Annual billing (2 months free) coming soon",
};

export const APP_URL = "https://showpilot.tech";
export const SIGNUP_URL = `${APP_URL}/login?signup=1`;
export const LOGIN_URL = `${APP_URL}/login`;
export const SUPPORT_EMAIL = "support@showpilot.tech";
