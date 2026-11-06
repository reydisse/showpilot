import { useEffect, useId, useRef, useState } from "react";
import { useRouter, useRouterState, type ErrorComponentProps } from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type RecoveryProps =
  | { kind: "not-found" }
  | { kind: "error"; retry: () => void; retrying: boolean; failedAt: number | null; retryFailed: boolean; href: string };

/** Plain links deliberately work even when the current router tree has failed. */
export function RouteRecovery(props: RecoveryProps) {
  const headingId = useId();
  const missing = props.kind === "not-found";

  return (
    <section className="route-recovery" aria-labelledby={headingId}>
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col">
        <a href="/" aria-label="ShowPilot home" className="flex min-h-11 w-fit items-center rounded-sm text-lg font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-fire-500">
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
            {props.kind === "error" && props.failedAt !== null && (
              <p role="alert" className="mt-3 max-w-sm text-sm leading-6 text-board-muted">
                {props.retryFailed ? "Still unable to load. Try again or reload this page." : "Page load failed."}{" "}
                <time dateTime={new Date(props.failedAt).toISOString()}>{new Date(props.failedAt).toLocaleTimeString()}</time>
              </p>
            )}

            <div className="mt-7 flex flex-wrap gap-3">
              {props.kind === "error" && (
                <Button type="button" size="lg" className="min-h-11" onClick={props.retry} disabled={props.retrying} aria-busy={props.retrying}>
                  <RotateCcw aria-hidden="true" className={props.retrying ? "motion-safe:animate-spin" : undefined} />
                  {props.retrying ? "Trying again…" : "Try again"}
                </Button>
              )}
              <Button asChild size="lg" className="min-h-11" variant={missing ? "default" : "outline"}>
                <a href="/">Back to workspace <ArrowRight aria-hidden="true" /></a>
              </Button>
              {props.kind === "error" && (
                <Button asChild size="lg" className="min-h-11" variant="outline"><a href={props.href}>Reload page</a></Button>
              )}
            </div>
          </div>

          <div className="recovery-cue order-1 hidden md:order-2 md:block" aria-hidden="true">
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
          <a href="mailto:support@showpilot.tech" className="inline-flex min-h-11 items-center gap-1 rounded-sm text-board-text underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-fire-500">
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

export function RouteError({ reset, error }: ErrorComponentProps) {
  const router = useRouter();
  const loading = useRouterState({ select: state => state.isLoading });
  const [retrying, setRetrying] = useState(false);
  const pending = useRef(false);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [retryFailed, setRetryFailed] = useState(false);
  useEffect(() => { setFailedAt(Date.now()); }, [error]);

  async function retry() {
    if (pending.current || router.state.isLoading) return;
    pending.current = true;
    setRetrying(true);
    try {
      // Every route phase has its own deadline. Await its actual termination:
      // an independent retry timer could unlock before a later loader expires.
      await router.invalidate();
      if (router.state.matches.some(match => match.status === "error")) {
        setRetryFailed(true);
        setFailedAt(Date.now());
      }
      reset();
    } catch {
      setRetryFailed(true);
      setFailedAt(Date.now());
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  }

  // Invalidation can remount the boundary before its new loaders finish. The
  // router's loading state survives that remount; local button state does not.
  return <RouteRecovery kind="error" retry={() => void retry()} retrying={retrying || loading} failedAt={failedAt} retryFailed={retryFailed} href={router.state.location.href} />;
}
