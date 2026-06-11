// ─────────────────────────────────────────────────────────────
// Plan limits + effective-plan resolution.
//
// The numbers below are launch defaults — keep them in this one
// file so they're trivially tunable.
//
// The top half of this module is pure (no env/db imports) so it can
// be unit-tested; DB-backed helpers at the bottom use dynamic
// imports, matching the pattern in settings.ts.
// ─────────────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  free:    { members: 5,   devices: 2,   shows: 3,   integrations: false, kiosk: false },
  starter: { members: 25,  devices: 10,  shows: 50,  integrations: true,  kiosk: true },
  pro:     { members: 100, devices: 999, shows: 999, integrations: true,  kiosk: true },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
export type PlanFeature = "integrations" | "kiosk";
export type PlanResource = "members" | "devices" | "shows";

const RESOURCE_LABELS: Record<PlanResource, string> = {
  members: "team members",
  devices: "devices",
  shows: "shows",
};

const FEATURE_LABELS: Record<PlanFeature, string> = {
  integrations: "Integrations",
  kiosk: "Kiosk displays",
};

/** 402-style error thrown when a plan limit blocks an action. */
export class PlanLimitError extends Error {
  status = 402;
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export interface OrgPlanFields {
  plan: string;
  trialEndsAt: Date | null;
  betaTester: boolean;
}

function asPlan(plan: string): Plan {
  return plan === "starter" || plan === "pro" ? plan : "free";
}

/**
 * Resolve the plan an org actually operates under. Precedence lives
 * in exactly this one place:
 *
 *   1. beta tester, before public launch (or launch date unset) → pro
 *   2. active trial → pro
 *   3. the org's paid/free plan
 *
 * Once publicLaunchDate passes, beta orgs naturally evaluate as their
 * stored plan (usually free) — no cron, no migration.
 */
export function getEffectivePlan(
  org: OrgPlanFields,
  publicLaunchDate: Date | null,
  now: Date = new Date(),
): Plan {
  if (org.betaTester && (!publicLaunchDate || now < publicLaunchDate)) {
    return "pro";
  }
  if (org.trialEndsAt && now < org.trialEndsAt) {
    return "pro";
  }
  return asPlan(org.plan);
}

/** Map a Stripe price ID to its plan. Founding members get pro. */
export function planFromPriceId(
  priceId: string,
  prices: { starter: string; pro: string; founding: string },
): { plan: Plan; foundingMember: boolean } | null {
  if (priceId === prices.founding) return { plan: "pro", foundingMember: true };
  if (priceId === prices.pro) return { plan: "pro", foundingMember: false };
  if (priceId === prices.starter) return { plan: "starter", foundingMember: false };
  return null;
}

// ─── DB-backed helpers ───────────────────────────────────────

export const PUBLIC_LAUNCH_DATE_KEY = "publicLaunchDate";

/** Platform-wide launch date; null = not yet set = beta access stays open. */
export async function getPublicLaunchDate(): Promise<Date | null> {
  const { getPrisma } = await import("@/lib/db");
  const prisma = getPrisma();
  const setting = await prisma.platformSetting.findUnique({
    where: { key: PUBLIC_LAUNCH_DATE_KEY },
  });
  if (!setting?.value) return null;
  const date = new Date(setting.value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function getEffectivePlanForOrg(orgId: string): Promise<Plan> {
  const { getPrisma } = await import("@/lib/db");
  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, trialEndsAt: true, betaTester: true },
  });
  if (!org) throw new Error("Organization not found");
  return getEffectivePlan(org, await getPublicLaunchDate());
}

/** Throw a PlanLimitError unless the org's effective plan includes `feature`. */
export async function requirePlanFeature(orgId: string, feature: PlanFeature): Promise<void> {
  const plan = await getEffectivePlanForOrg(orgId);
  if (!PLAN_LIMITS[plan][feature]) {
    throw new PlanLimitError(
      `${FEATURE_LABELS[feature]} are not included in the ${plan} plan. Upgrade in Settings → Billing.`,
    );
  }
}

/** Throw a PlanLimitError if adding one more `resource` would exceed the plan cap. */
export async function checkPlanLimit(
  orgId: string,
  resource: PlanResource,
  currentCount: number,
): Promise<void> {
  const plan = await getEffectivePlanForOrg(orgId);
  const limit = PLAN_LIMITS[plan][resource];
  if (currentCount >= limit) {
    throw new PlanLimitError(
      `The ${plan} plan allows up to ${limit} ${RESOURCE_LABELS[resource]}. Upgrade in Settings → Billing.`,
    );
  }
}
