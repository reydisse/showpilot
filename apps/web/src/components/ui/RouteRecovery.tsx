import { useId, useState } from "react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type RecoveryProps =
  | { kind: "not-found" }
  | { kind: "error"; retry: () => void; retrying: boolean };

/** Plain links deliberately work even when the current router tree has failed. */
export function RouteRecovery(props: RecoveryProps) {
  const headingId = useId();
  const missing = props.kind === "not-found";

  return (
    <section className="route-recovery" aria-labelledby={headingId}>
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col">
        <a href="/" aria-label="ShowPilot home" className="w-fit rounded-sm text-lg font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-fire-500">
          <span className="text-fire-500">Show</span>Pilot
        </a>

        <div className="grid flex-1 items-center gap-10 py-12 md:grid-cols-[1.15fr_1fr] md:gap-16 md:py-20">
          <div className="order-2 md:order-1">
            <p className="mb-4 flex items-center gap-2.5 text-xs font-medium tracking-wide text-board-muted">
              <span className="size-1.5 rounded-full bg-fire-500" aria-hidden="true" />
              {missing ? "404 / Page not found" : "Something went wrong"}
            </p>
            <h1 id={headingId} className="max-w-sm text-3xl font-semibold leading-tight tracking-tight text-board-text sm:text-4xl">
              {missing ? "This page is off the rundown." : "Let's get you back on cue."}
            </h1>
            <p className="mt-4 max-w-sm text-sm leading-7 text-board-muted">
              {missing
                ? "The link may have changed, or this page is no longer available. Your workspace is a click away."
                : "We couldn't load this page. Try again, or return to your workspace to continue."}
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              {props.kind === "error" && (
                <Button type="button" size="lg" onClick={props.retry} disabled={props.retrying} aria-busy={props.retrying}>
                  <RotateCcw aria-hidden="true" className={props.retrying ? "motion-safe:animate-spin" : undefined} />
                  {props.retrying ? "Trying again…" : "Try again"}
                </Button>
              )}
              <Button asChild size="lg" variant={missing ? "default" : "outline"}>
                <a href="/">Back to workspace <ArrowRight aria-hidden="true" /></a>
              </Button>
            </div>
          </div>

          <div className="recovery-cue order-1 md:order-2" aria-hidden="true">
            <div className="recovery-cue-rail"><span /> <span /> <span /></div>
            <div className="recovery-cue-card">
              <div className="flex items-center justify-between border-b border-board-border px-5 py-3 font-mono text-[10px] uppercase tracking-[0.15em] text-board-muted">
                <span>ShowPilot / Rundown</span><span>— : —</span>
              </div>
              <div className="px-6 py-7">
                <div className="recovery-cue-code">{missing ? "404" : "— —"}</div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-board-muted">
                  <span className="h-px w-5 bg-fire-500/70" />
                  {missing ? "Cue not found" : "Standing by"}
                </div>
              </div>
              <div className="recovery-cue-track"><span /></div>
              <div className="flex items-center justify-between px-5 py-3 font-mono text-[10px] tracking-wider text-board-muted">
                <span>{missing ? "— / —" : "RETRY AVAILABLE"}</span><span>SP</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-board-border pt-5 text-xs text-board-muted">
          <span>{missing ? "Check the link, or head back to familiar ground." : "Still stuck? We're here to help."}</span>
          <a href="mailto:support@showpilot.tech" className="inline-flex items-center gap-1 rounded-sm text-board-text underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-fire-500">
            Contact support <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}

export function RouteNotFound() {
  return <RouteRecovery kind="not-found" />;
}

export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      // Reload failed loaders as well as resetting render failures.
      await router.invalidate();
      reset();
    } finally {
      setRetrying(false);
    }
  }

  return <RouteRecovery kind="error" retry={() => void retry()} retrying={retrying} />;
}
