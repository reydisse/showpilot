import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { safeAuthReturnTo, verificationHref } from "@/lib/auth-navigation";
import { withOperationTimeout } from "@/lib/operation-timeout";

export const Route = createFileRoute("/_auth/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: safeAuthReturnTo(search.returnTo),
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: VerifyEmailPage,
});

type VerificationState =
  | { status: "checking" | "anonymous" }
  | { status: "verified" | "unverified"; email: string }
  | { status: "error"; at: number };
type DeliveryState =
  | { status: "idle" }
  | { status: "sending" | "sent"; email: string }
  | { status: "error"; email: string; at: number };
const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-board-border px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-50";

function VerifyEmailPage() {
  const { error: linkError, returnTo } = Route.useSearch();
  const [attempt, setAttempt] = useState(0);
  const [verification, setVerification] = useState<VerificationState>({ status: "checking" });
  const [delivery, setDelivery] = useState<DeliveryState>({ status: "idle" });
  const deliveryRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    void withOperationTimeout(authClient.getSession({
      query: { disableCookieCache: true }, fetchOptions: { signal: request.signal },
    }), 8_000, "Verification status was not confirmed in time.").then(result => {
      if (request.signal.aborted) return;
      if (result.error) { setVerification({ status: "error", at: Date.now() }); return; }
      const user = result.data?.user;
      setVerification(user ? { status: user.emailVerified === true ? "verified" : "unverified", email: user.email } : { status: "anonymous" });
    }).catch(() => {
      if (!request.signal.aborted) setVerification({ status: "error", at: Date.now() });
    }).finally(() => request.abort());
    return () => { request.abort(); deliveryRequest.current?.abort(); };
  }, [attempt]);

  function checkAgain() {
    setVerification({ status: "checking" });
    setAttempt(value => value + 1);
  }
  async function resend() {
    if (verification.status !== "unverified" || delivery.status === "sending") return;
    const email = verification.email;
    const request = new AbortController();
    deliveryRequest.current = request;
    setDelivery({ status: "sending", email });
    try {
      const result = await withOperationTimeout(authClient.sendVerificationEmail({ email, callbackURL: verificationHref(returnTo), fetchOptions: { signal: request.signal } }), 8_000, "Email delivery was not confirmed in time.");
      if (request.signal.aborted) return;
      setDelivery(result.error || result.data?.status !== true ? { status: "error", email, at: Date.now() } : { status: "sent", email });
    } catch {
      if (!request.signal.aborted) setDelivery({ status: "error", email, at: Date.now() });
    } finally { request.abort(); }
  }

  return <div className="animate-float-in">
    <div className="mb-8 text-center">
      <h1 className="text-3xl font-bold tracking-tight"><span className="text-fire-500">Show</span>Pilot</h1>
      <p className="mt-1 text-sm uppercase tracking-widest text-board-muted">Email verification</p>
    </div>
    <section className="space-y-4 rounded-2xl border border-board-border bg-board-card p-6 text-center shadow-2xl" aria-live="polite">
      {verification.status === "checking" && <p role="status">Checking email verification…</p>}
      {verification.status === "error" && <>
        <h2 className="text-xl font-semibold">Verification status unavailable</h2>
        <p role="alert" className="text-sm text-red-300">We couldn't confirm your email verification. Try again. <span className="block">Last attempt: {new Date(verification.at).toLocaleTimeString()}</span></p>
        <button type="button" className={buttonClass} onClick={checkAgain}>Retry verification check</button>
      </>}
      {verification.status === "anonymous" && <>
        <h2 className="text-xl font-semibold">Sign in to check verification</h2>
        <p className="text-sm text-board-muted">{linkError ? "This verification link is invalid or has expired. Sign in to request another email." : "Sign in with the email address you want to verify."}</p>
        <Link to="/login" search={{ verify: 1, returnTo }} className={`${buttonClass} bg-fire-500 text-black`}>Sign in</Link>
      </>}
      {verification.status === "unverified" && <>
        <Mail className="mx-auto h-10 w-10 text-fire-500" aria-hidden="true" />
        <h2 className="text-xl font-semibold">{linkError ? "Verification link failed" : "Check your inbox"}</h2>
        {linkError && <p role="alert" className="text-sm text-red-300">That verification link is invalid or has expired. Request a new one.</p>}
        <p className="break-words text-sm text-board-muted">Your email address, {verification.email}, isn't verified yet. Open the verification link in your inbox, then check again.</p>
        <div className="flex flex-col gap-3">
          <button type="button" className={`${buttonClass} bg-fire-500 text-black`} disabled={delivery.status === "sending"} onClick={checkAgain}>I've verified my email</button>
          <button type="button" className={buttonClass} disabled={delivery.status === "sending" || (delivery.status === "sent" && delivery.email === verification.email)} onClick={() => void resend()}>
            {delivery.status === "sending" ? "Sending verification email…" : delivery.status === "error" && delivery.email === verification.email ? "Retry sending verification email" : "Resend verification email"}
          </button>
        </div>
        {delivery.status === "sent" && delivery.email === verification.email && <p role="status" className="text-sm">Verification email sent. Check your inbox.</p>}
        {delivery.status === "error" && delivery.email === verification.email && <p role="alert" className="text-sm text-red-300">We couldn't confirm that the email was sent. Try again. <span className="block">Last attempt: {new Date(delivery.at).toLocaleTimeString()}</span></p>}
      </>}
      {verification.status === "verified" && <>
        <CheckCircle2 className="mx-auto h-10 w-10 text-green-400" aria-hidden="true" />
        <h2 className="text-xl font-semibold">Email verified</h2>
        <p className="break-words text-sm text-board-muted">{verification.email} is verified. You can continue to your workspace.</p>
        <Link to={returnTo ?? "/setup"} className={`${buttonClass} bg-fire-500 text-black`}>Continue</Link>
      </>}
    </section>
  </div>;
}
