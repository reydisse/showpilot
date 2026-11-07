import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { checkPasswordResetLink } from "@/lib/password-reset";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { PASSWORD_MIN_LENGTH } from "@showpilot/shared";

export const Route = createFileRoute("/_auth/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" && search.token.length <= 256 ? search.token : "",
  }),
  component: ResetPasswordPage,
});

type ResetState =
  | { status: "checking" | "invalid" | "ready" | "submitting" | "success" }
  | { status: "check-error" | "uncertain"; at: number };
const linkClass = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500";
const inputClass = "min-h-12 w-full rounded-xl border border-board-border bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500";

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  // Changing links discards the old form and cancels its requests immediately.
  return <ResetPasswordForm key={token} token={token} />;
}

function ResetPasswordForm({ token }: { token: string }) {
  const [state, setState] = useState<ResetState>({ status: token ? "checking" : "invalid" });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<{ message: string; at: number } | null>(null);
  const saving = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setState({ status: "checking" });
    void (async () => {
      try {
        const result = await withOperationTimeout(checkPasswordResetLink({ data: { token }, signal: controller.signal }), 8_000, "Reset link check timed out.");
        if (!controller.signal.aborted) setState({ status: result.valid ? "ready" : "invalid" });
      } catch {
        if (!controller.signal.aborted) setState({ status: "check-error", at: Date.now() });
      } finally { controller.abort(); }
    })();
    return () => controller.abort();
  }, [token, attempt]);
  useEffect(() => () => { saving.current?.abort(); }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (state.status !== "ready" || saving.current) return;
    setError(null);
    if (password !== confirmPassword) {
      setError({ message: "Passwords do not match.", at: Date.now() });
      return;
    }
    const controller = new AbortController();
    saving.current = controller;
    setState({ status: "submitting" });
    try {
      const result = await withOperationTimeout(authClient.resetPassword({ newPassword: password, token, fetchOptions: { signal: controller.signal, retry: 0 } }), 8_000, "Reset confirmation timed out.");
      if (controller.signal.aborted) return;
      if (result.error) {
        if (result.error.code === "INVALID_TOKEN") { setState({ status: "invalid" }); setPassword(""); setConfirmPassword(""); return; }
        const message = result.error.code === "PASSWORD_TOO_SHORT" ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
          : result.error.code === "PASSWORD_TOO_LONG" ? "Use no more than 128 characters."
          : result.error.status === 429 ? "Too many attempts. Wait a minute, then try again." : null;
        if (!message) throw new Error("Reset outcome unavailable.");
        setState({ status: "ready" }); setError({ message, at: Date.now() });
        return;
      }
      if (result.data?.status !== true) throw new Error("Reset acknowledgement missing.");
      setState({ status: "success" }); setPassword(""); setConfirmPassword("");
    } catch {
      // An aborted/lost acknowledgement cannot prove that the password was not
      // changed. The one-use token makes automatic write retries unsafe.
      if (!controller.signal.aborted) {
        setState({ status: "uncertain", at: Date.now() }); setPassword(""); setConfirmPassword("");
      }
    } finally { controller.abort(); if (saving.current === controller) saving.current = null; }
  }

  const busy = state.status === "submitting";
  return <div className="animate-float-in">
    <h1 className="mb-8 text-center text-3xl font-bold tracking-tight"><span className="text-fire-500">Show</span>Pilot</h1>
    <section aria-label="Password reset" className="space-y-4 rounded-2xl border border-board-border bg-board-surface p-5 text-center shadow-2xl sm:p-8">
      {state.status === "checking" && <><h2 className="text-xl font-semibold">Checking reset link</h2><p role="status" className="text-sm text-board-muted">Checking that your link is still valid…</p></>}
      {state.status === "check-error" && <>
        <h2 className="text-xl font-semibold">Reset link check unavailable</h2>
        <p role="alert" className="text-sm text-red-300">We couldn't check this link. Wait a moment and retry.<br />Last attempt: {new Date(state.at).toLocaleTimeString()}</p>
        <Button className="min-h-11" onClick={() => setAttempt(value => value + 1)}>Retry link check</Button>
      </>}
      {state.status === "invalid" && <>
        <h2 className="text-xl font-semibold">Reset link unavailable</h2>
        <p role="alert" className="text-sm text-board-muted">This link is missing, invalid, expired, or already used. Request a new link to reset your password.</p>
        <Link to="/forgot-password" className={`${linkClass} bg-fire-500 text-black`}>Request a new reset link</Link>
      </>}
      {state.status === "uncertain" && <>
        <h2 className="text-xl font-semibold">Reset not confirmed</h2>
        <p role="alert" className="text-sm text-red-300">We couldn't confirm whether your password changed. Try signing in with your new password. If that doesn't work, request a new reset link.<br />Last attempt: {new Date(state.at).toLocaleTimeString()}</p>
        <Link to="/login" className={`${linkClass} bg-fire-500 text-black`}>Try signing in</Link>
        <Link to="/forgot-password" className={linkClass}>Request a new reset link</Link>
      </>}
      {state.status === "success" && <>
        <Check className="mx-auto size-10 text-green-400" aria-hidden="true" />
        <h2 className="text-xl font-semibold">Password reset!</h2>
        <p className="text-sm text-board-muted">Your new password is ready to use.</p>
        <Link to="/login" className={`${linkClass} bg-fire-500 text-black`}>Sign in now</Link>
      </>}
      {(state.status === "ready" || busy) && <>
        <h2 className="text-xl font-semibold">Set your new password</h2>
        <form onSubmit={handleSubmit} className="space-y-4 text-left" aria-busy={busy}>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">New Password</label>
            <div className="relative">
              <input id="password" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`} className={`${inputClass} pr-12`} />
              <button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-board-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500">
                {showPassword ? <EyeOff aria-hidden="true" className="size-5" /> : <Eye aria-hidden="true" className="size-5" />}
              </button>
            </div>
          </div>
          <div>
            <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium">Confirm Password</label>
            <input id="confirmPassword" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={128} disabled={busy} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} className={inputClass} />
          </div>
          {error && <p role="alert" className="text-sm text-red-300">{error.message}<br />Last attempt: {new Date(error.at).toLocaleTimeString()}</p>}
          <Button type="submit" disabled={busy} className="min-h-12 w-full rounded-xl">{busy ? "Resetting…" : error ? "Try again" : "Reset password"}</Button>
        </form>
      </>}
      {state.status !== "success" && state.status !== "uncertain" && <Link to="/login" className={`${linkClass} text-board-muted`}>Back to sign in</Link>}
    </section>
  </div>;
}
