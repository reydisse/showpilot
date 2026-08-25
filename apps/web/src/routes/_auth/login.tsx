import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/login")({
  // ?signup=1 opens the page in sign-up mode — the landing page's CTAs land
  // here. Unknown params (utm_*) pass through untouched for analytics.
  validateSearch: (search: Record<string, unknown>): { signup?: 1 } =>
    search.signup === "1" || search.signup === 1 ? { signup: 1 } : {},
  component: LoginPage,
});

function LoginPage() {
  const { signup } = Route.useSearch();
  const [isSignUp, setIsSignUp] = useState(Boolean(signup));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isSignUp) {
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) throw new Error(`[${result.error.code ?? "ERR"}] ${result.error.message}`);
        window.location.href = "/";
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? "Sign in failed");
        window.location.href = "/";
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-float-in">
      {/* Logo & Brand */}
      <div className="mb-8 flex flex-col items-center">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-fire-500">Show</span>
          <span className="text-board-text">Pilot</span>
        </h1>
        <p className="mt-1 text-sm tracking-widest uppercase text-board-muted">
          Production Board
        </p>
      </div>

      {/* Card */}
      <div className="rounded-2xl border border-board-border bg-board-card/80 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
        <h2 className="mb-6 text-center text-xl font-semibold text-board-text">
          {isSignUp ? "Create your account" : "Welcome back"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div className="group">
              <label
                htmlFor="name"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
              >
                Full Name
              </label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full rounded-xl border border-board-border bg-board-bg/70 px-4 py-3 text-board-text placeholder:text-board-muted/70 outline-none transition-all duration-200 focus:border-fire-500/60 focus:ring-2 focus:ring-fire-500/20"
              />
            </div>
          )}

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
              className="w-full rounded-xl border border-board-border bg-board-bg/70 px-4 py-3 text-board-text placeholder:text-board-muted/70 outline-none transition-all duration-200 focus:border-fire-500/60 focus:ring-2 focus:ring-fire-500/20"
            />
          </div>

          <div className="group">
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="password"
                className="block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
              >
                Password
              </label>
              {!isSignUp && (
                <Link
                  to="/forgot-password"
                  className="text-xs text-fire-500/70 hover:text-fire-500 transition-colors"
                >
                  Forgot password?
                </Link>
              )}
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-xl border border-board-border bg-board-bg/70 px-4 py-3 pr-11 text-board-text placeholder:text-board-muted/70 outline-none transition-all duration-200 focus:border-fire-500/60 focus:ring-2 focus:ring-fire-500/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-board-muted/60 hover:text-board-muted transition-colors"
              >
                {showPassword ? (
                  <EyeOff className="size-[18px]" />
                ) : (
                  <Eye className="size-[18px]" />
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="relative mt-2 w-full overflow-hidden rounded-xl px-4 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            style={{
              background:
                "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
            }}
          >
            {loading
              ? isSignUp
                ? "Creating account..."
                : "Signing in..."
              : isSignUp
                ? "Create Account"
                : "Sign In"}
          </button>

          {isSignUp && (
            <p className="text-center text-[11px] leading-5 text-board-muted/70">
              By creating an account you agree to the{" "}
              <Link to="/terms" className="text-fire-500/80 hover:text-fire-500 underline-offset-2 hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link to="/privacy" className="text-fire-500/80 hover:text-fire-500 underline-offset-2 hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          )}
        </form>

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-board-border" />
          <span className="text-xs text-board-muted">
            {isSignUp ? "Already have an account?" : "New to ShowPilot?"}
          </span>
          <div className="h-px flex-1 bg-board-border" />
        </div>

        <button
          type="button"
          onClick={() => {
            setIsSignUp(!isSignUp);
            setError(null);
          }}
          className="w-full rounded-xl border border-board-border bg-board-bg/60 px-4 py-2.5 text-sm font-medium text-board-text transition-all duration-200 hover:border-fire-500/40 hover:bg-board-bg"
        >
          {isSignUp ? "Sign in instead" : "Create an account"}
        </button>
      </div>

      <p className="mt-6 text-center text-xs text-board-muted/60">
        Powering live production teams everywhere
      </p>
    </div>
  );
}
