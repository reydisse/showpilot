import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isSignUp) {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name,
        });
        if (error) throw new Error(error.message);
        navigate({ to: "/setup" });
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
        });
        if (error) throw new Error(error.message);
        navigate({ to: "/" });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Authentication failed"
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
      <div
        className="rounded-2xl border border-white/[0.08] p-8 shadow-2xl backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
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
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:bg-white/[0.05] focus:ring-1 focus:ring-fire-500/20"
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
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:bg-white/[0.05] focus:ring-1 focus:ring-fire-500/20"
            />
          </div>

          <div className="group">
            <label
              htmlFor="password"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
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
        </form>

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/[0.06]" />
          <span className="text-xs text-board-muted">
            {isSignUp ? "Already have an account?" : "New to ShowPilot?"}
          </span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>

        <button
          type="button"
          onClick={() => {
            setIsSignUp(!isSignUp);
            setError(null);
          }}
          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-board-text transition-all duration-200 hover:border-fire-500/30 hover:bg-white/[0.05]"
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
