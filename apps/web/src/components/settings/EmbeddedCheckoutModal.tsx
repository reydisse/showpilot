import { useMemo } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { X, AlertTriangle } from "lucide-react";
import { getStripePublishableKey } from "@/lib/checkout";

// Embedded Stripe Checkout in a broadcast-dark modal — payment never leaves
// showpilot.tech. Only rendered when the publishable key is configured; the
// caller falls back to hosted checkout otherwise (see resolveCheckoutUiMode).

let stripePromiseCache: ReturnType<typeof loadStripe> | null = null;

function getStripePromise() {
  if (!stripePromiseCache) {
    const key = getStripePublishableKey();
    stripePromiseCache = key ? loadStripe(key) : Promise.resolve(null);
  }
  return stripePromiseCache;
}

export function EmbeddedCheckoutModal({
  clientSecret,
  planName,
  onClose,
}: {
  clientSecret: string;
  planName: string;
  onClose: () => void;
}) {
  const stripePromise = useMemo(getStripePromise, []);
  const options = useMemo(() => ({ clientSecret }), [clientSecret]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-board-border bg-board-card shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-board-border shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-board-text">
              Subscribe to {planName}
            </h3>
            <p className="text-[11px] text-board-muted mt-0.5">
              Payment is processed securely by Stripe — you stay on showpilot.tech.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close checkout"
            className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stripe's iframe is light-themed; min-height keeps the modal stable
            while stripe.js boots and shows its own loading state. */}
        <div className="overflow-y-auto rounded-b-2xl bg-white min-h-[480px]">
          {stripePromise ? (
            <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          ) : (
            <div className="flex items-center gap-2 p-6 text-sm text-red-500">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Checkout could not be loaded. Close this dialog and try again.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
