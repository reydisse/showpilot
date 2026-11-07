import { lazy, Suspense, useEffect, useState } from "react";
import { Check, ExternalLink, FlaskConical, LoaderCircle } from "lucide-react";
import {
  createCheckoutSession,
  createPortalSession,
  type OrgBillingInfo,
} from "@/lib/billing";
import { getStripePublishableKey, resolveCheckoutUiMode } from "@/lib/checkout";
import { subscriptionGrantsPaidAccess } from "@/lib/plan-limits";
const loadEmbeddedCheckoutModal = () => import("./EmbeddedCheckoutModal");
const EmbeddedCheckoutModal = lazy(loadEmbeddedCheckoutModal);

const PLAN_CARDS: Array<{
  plan: "starter" | "pro" | "founding";
  name: string;
  price: number;
  tagline: string;
  features: string[];
}> = [
  {
    plan: "starter",
    name: "Starter",
    price: 39,
    tagline: "For small teams running weekly shows",
    features: [
      "25 team members",
      "10 devices",
      "50 shows",
      "Integrations",
      "Kiosk displays",
    ],
  },
  {
    plan: "pro",
    name: "Pro",
    price: 79,
    tagline: "Full production power, no ceilings",
    features: [
      "100 team members",
      "Unlimited devices",
      "Unlimited shows",
      "Integrations",
      "Kiosk displays",
    ],
  },
  {
    plan: "founding",
    name: "Founding",
    price: 25,
    tagline: "Everything in Pro, locked in for early teams",
    features: ["All Pro features", "$25/mo locked in", "Founding member badge"],
  },
];

function billingBannerFromUrl(): "success" | "cancelled" | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("billing");
  return value === "success" || value === "cancelled" ? value : null;
}

export function BillingSection({
  orgId,
  billing,
}: {
  orgId: string;
  billing: OrgBillingInfo | null;
}) {
  const [banner] = useState<"success" | "cancelled" | null>(
    billingBannerFromUrl,
  );
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [embeddedCheckout, setEmbeddedCheckout] = useState<{
    clientSecret: string;
    planName: string;
  } | null>(null);

  // Drop the ?billing= param so refreshes don't re-show the banner.
  useEffect(() => {
    if (banner) {
      const url = new URL(window.location.href);
      url.searchParams.delete("billing");
      window.history.replaceState({}, "", url);
    }
  }, [banner]);

  if (!billing) {
    return (
      <div>
        <p className="text-sm text-board-muted">
          Billing is only visible to owners and admins.
        </p>
      </div>
    );
  }

  const now = new Date();
  const trialEndsAt = billing.trialEndsAt
    ? new Date(billing.trialEndsAt)
    : null;
  const trialActive = trialEndsAt !== null && trialEndsAt > now;
  const trialDaysLeft = trialActive
    ? Math.max(
        1,
        Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000),
      )
    : 0;
  const launchDate = billing.publicLaunchDate
    ? new Date(billing.publicLaunchDate)
    : null;
  const betaActive = billing.betaTester && (!launchDate || now < launchDate);

  // The stored subscription and temporary feature access answer different questions.
  const savedPlan =
    billing.plan === "pro"
      ? billing.foundingMember
        ? "founding"
        : "pro"
      : billing.plan === "starter"
        ? "starter"
        : "free";
  const currentPlan = subscriptionGrantsPaidAccess(billing.subscriptionStatus)
    ? savedPlan
    : "free";
  const planName = (plan: string) =>
    plan.charAt(0).toUpperCase() + plan.slice(1);

  const handleCheckout = async (plan: "starter" | "pro" | "founding") => {
    setCheckingOut(plan);
    setBillingError(null);
    try {
      // Embedded keeps payment on showpilot.tech; without the publishable
      // key the flow degrades to the original hosted redirect.
      const uiMode = resolveCheckoutUiMode(getStripePublishableKey());
      if (uiMode === "embedded") void loadEmbeddedCheckoutModal();
      const result = await createCheckoutSession({
        data: { orgId: orgId, plan, uiMode },
      });
      if (result.mode === "embedded") {
        setEmbeddedCheckout({
          clientSecret: result.clientSecret,
          planName:
            plan === "founding"
              ? "Founding"
              : plan === "pro"
                ? "Pro"
                : "Starter",
        });
        setCheckingOut(null);
      } else {
        window.location.href = result.url;
      }
    } catch (err) {
      setBillingError(
        err instanceof Error ? err.message : "Failed to start checkout",
      );
      setCheckingOut(null);
    }
  };

  const handlePortal = async () => {
    setOpeningPortal(true);
    setBillingError(null);
    try {
      const { url } = await createPortalSession({ data: { orgId: orgId } });
      window.location.href = url;
    } catch (err) {
      setBillingError(
        err instanceof Error ? err.message : "Failed to open billing portal",
      );
      setOpeningPortal(false);
    }
  };

  const visibleCards = PLAN_CARDS.filter(
    (card) =>
      card.plan !== "founding" ||
      billing.foundingEligible ||
      currentPlan === "founding",
  );

  return (
    <div>
      {banner === "success" && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-green-500/20 bg-green-500/10 flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 shrink-0" />
          <p className="text-sm text-green-400">
            Payment successful — your plan will update within a few seconds.
          </p>
        </div>
      )}
      {banner === "cancelled" && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-board-border bg-board-card flex items-center gap-2">
          <p className="text-sm text-board-muted">
            Checkout cancelled — no changes were made.
          </p>
        </div>
      )}
      {billingError && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/10">
          <p className="text-sm text-red-400">{billingError}</p>
        </div>
      )}

      <section
        aria-label="Current plan and access"
        className="rounded-xl border border-board-border bg-board-card p-4 mb-5"
      >
        <p className="text-base font-semibold text-board-text">
          Current plan: {planName(currentPlan)}
        </p>
        <p className="mt-2 text-sm text-board-muted">
          Features available now: {planName(billing.effectivePlan)}
        </p>
        {betaActive ? (
          <p className="mt-2 text-sm text-purple-400">
            Pro beta access is free until public launch.
          </p>
        ) : trialActive ? (
          <p className="mt-2 text-sm text-board-muted">
            Pro trial access: {trialDaysLeft} day
            {trialDaysLeft !== 1 ? "s" : ""} left. After the trial, your{" "}
            {planName(currentPlan)} plan applies.
          </p>
        ) : null}
        {billing.subscriptionStatus && (
          <p className="mt-2 text-sm text-board-muted">
            Subscription status:{" "}
            {billing.subscriptionStatus.replaceAll("_", " ")}
            {savedPlan !== currentPlan
              ? `. The saved ${planName(savedPlan)} subscription is not providing paid access.`
              : "."}
          </p>
        )}
        {billing.hasStripeCustomer && (
          <button
            onClick={handlePortal}
            disabled={openingPortal}
            className="min-h-11 focus-visible:outline-2 focus-visible:outline-fire-500 mt-3 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-board-text border border-board-border hover:bg-board-border/50 transition-colors disabled:opacity-50"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {openingPortal ? "Opening..." : "Manage billing"}
          </button>
        )}
      </section>

      {betaActive ? (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5">
          <div className="flex items-center gap-2 mb-1">
            <FlaskConical className="w-4 h-4 text-purple-400" />
            <p className="text-sm font-medium text-board-text">Beta access</p>
          </div>
          {launchDate ? (
            <>
              <p className="text-xs text-board-muted mb-4">
                Your team has full Pro access free until public launch on{" "}
                <span className="text-board-text font-medium">
                  {launchDate.toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
                . Your current plan is shown above; subscribing is a separate
                purchase.
              </p>
              {billing.foundingEligible && currentPlan !== "founding" && (
                <button
                  onClick={() => handleCheckout("founding")}
                  disabled={checkingOut !== null}
                  className="min-h-11 px-4 py-2.5 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 transition-colors disabled:opacity-50"
                >
                  {checkingOut === "founding"
                    ? "Redirecting..."
                    : "Subscribe to Founding — $25/mo"}
                </button>
              )}
            </>
          ) : (
            <p className="text-xs text-board-muted">
              Your team has full Pro access free until public launch. We&apos;ll
              let you know before anything changes.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {visibleCards.map((card) => {
            const isCurrent = currentPlan === card.plan;
            return (
              <div
                key={card.plan}
                role="group"
                aria-label={`${card.name} plan`}
                className={`rounded-xl border p-4 flex flex-col ${
                  isCurrent
                    ? "border-fire-500/50 bg-fire-500/5"
                    : "border-board-border bg-board-card"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-board-text">
                    {card.name}
                  </p>
                  {card.plan === "founding" && !isCurrent && (
                    <span className="text-xs font-medium uppercase px-2 py-0.5 rounded bg-fire-500/10 text-fire-500 border border-fire-500/20">
                      Available offer
                    </span>
                  )}
                </div>
                <p className="text-2xl font-bold text-board-text">
                  ${card.price}
                  <span className="text-xs font-normal text-board-muted">
                    /mo
                  </span>
                </p>
                <p className="text-xs text-board-muted mt-1 mb-3">
                  {card.tagline}
                </p>
                <ul className="space-y-1.5 mb-4 flex-1">
                  {card.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center gap-1.5 text-xs text-board-muted"
                    >
                      <Check className="w-3 h-3 text-fire-500 shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <span className="text-center text-xs font-medium px-3 py-2.5 rounded-xl border border-board-border text-board-muted">
                    Current plan
                  </span>
                ) : (
                  <button
                    onClick={() => handleCheckout(card.plan)}
                    disabled={checkingOut !== null}
                    className={`min-h-11 focus-visible:outline-2 focus-visible:outline-fire-500 text-sm font-medium px-3 py-2.5 rounded-xl transition-colors disabled:opacity-50 ${"border border-fire-500/30 text-fire-500 hover:bg-fire-500/10"}`}
                  >
                    {checkingOut === card.plan
                      ? "Redirecting..."
                      : `Subscribe to ${card.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-board-muted/60 mt-4">
        Prices are in USD. Subscriptions are handled securely by Stripe.
        Downgrades keep your data — limits apply to new items only.
      </p>

      {embeddedCheckout && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
              <div
                role="status"
                className="flex items-center gap-3 rounded-xl border border-board-border bg-board-card px-5 py-4 text-sm text-board-text shadow-2xl"
              >
                <LoaderCircle className="size-4 animate-spin text-fire-500" />
                Preparing secure checkout...
              </div>
            </div>
          }
        >
          <EmbeddedCheckoutModal
            clientSecret={embeddedCheckout.clientSecret}
            planName={embeddedCheckout.planName}
            onClose={() => setEmbeddedCheckout(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
