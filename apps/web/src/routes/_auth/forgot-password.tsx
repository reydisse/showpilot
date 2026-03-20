import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/forgot-password")({
  component: ForgotPasswordPage,
});

const COOLDOWN_SECONDS = 60;

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const isDisabled = loading || cooldown > 0;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (isDisabled) return;
      setError(null);
      setLoading(true);

      try {
        const { error } = await authClient.requestPasswordReset({
          email,
          redirectTo: "/reset-password",
        });
        if (error) throw new Error(error.message);
        setSent(true);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to send reset link"
        );
      } finally {
        setLoading(false);
        // Always start cooldown — prevents spam whether it succeeded or failed
        setCooldown(COOLDOWN_SECONDS);
      }
    },
    [email, isDisabled]
  );

  return (
    <div className="animate-float-in">
      {/* Logo & Brand */}
      <div className="mb-8 flex flex-col items-center">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-fire-500">Show</span>
          <span className="text-board-text">Pilot</span>
        </h1>
        <p className="mt-1 text-sm tracking-widest uppercase text-board-muted">
          Reset your password
        </p>
      </div>

      {/* Card */}
      <div
        className="rounded-2xl border border-white/[0.08] p-8 shadow-2xl backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
        {sent ? (
          <div className="text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 border border-green-500/20">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-green-400"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-board-text">
              Check your email
            </h2>
            <p className="text-sm text-board-muted">
              If an account exists for{" "}
              <span className="text-board-text">{email}</span>, we've sent a
              password reset link.
            </p>
            <div className="flex flex-col items-center gap-3 pt-2">
              {cooldown > 0 ? (
                <p className="text-sm text-board-muted/40">
                  Resend available in {cooldown}s
                </p>
              ) : (
                <button
                  onClick={() => { setSent(false); setError(null); }}
                  className="text-sm text-fire-500/70 hover:text-fire-500 transition-colors"
                >
                  Didn't get it? Send again
                </button>
              )}
              <Link
                to="/login"
                className="text-sm text-board-muted hover:text-board-text transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <>
            <h2 className="mb-2 text-center text-xl font-semibold text-board-text">
              Forgot your password?
            </h2>
            <p className="mb-6 text-center text-sm text-board-muted">
              Enter your email and we'll send you a reset link.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="group">
                <label
                  htmlFor="email"
                  className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:bg-white/[0.05] focus:ring-1 focus:ring-fire-500/20"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5">
                  <p className="text-sm text-red-300">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={isDisabled}
                className="relative mt-2 w-full overflow-hidden rounded-xl px-4 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                style={{
                  background:
                    "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                }}
              >
                {loading
                  ? "Sending..."
                  : cooldown > 0
                    ? `Wait ${cooldown}s`
                    : "Send Reset Link"}
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link
                to="/login"
                className="text-sm text-board-muted hover:text-board-text transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
