import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { SignInShell } from "@/components/auth/SignInShell";
import { getSignInDesign } from "@showpilot/shared";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH } from "@showpilot/shared";

export const Route = createFileRoute("/_auth/login")({
  // ?signup=1 opens the page in sign-up mode — the landing page's CTAs land
  // here. Unknown params (utm_*) pass through untouched for analytics.
  validateSearch: (
    search: Record<string, unknown>,
  ): { signup?: 1; returnTo?: string } => {
    const signup =
      search.signup === "1" || search.signup === 1 ? (1 as const) : undefined;
    const returnTo =
      typeof search.returnTo === "string" &&
      /^\/(?:delete-account(?:\?token=[A-Za-z0-9]+)?|setup\?mode=new)$/.test(search.returnTo)
        ? search.returnTo
        : undefined;
    return { signup, returnTo };
  },
  loader: () => ({ design: getSignInDesign(new Date()) }),
  component: LoginPage,
});

function LoginPage() {
  const { signup, returnTo } = Route.useSearch();
  const { design } = Route.useLoaderData();
  const [isSignUp, setIsSignUp] = useState(Boolean(signup));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [existingAccount, setExistingAccount] = useState(false);
  const [createOrgAfterSignIn, setCreateOrgAfterSignIn] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setExistingAccount(false);
    setLoading(true);

    try {
      if (isSignUp) {
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error?.code === "USER_ALREADY_EXISTS" || result.error?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
          setExistingAccount(true);
          setError("An account with this email already exists. Sign in to create another organization.");
          return;
        }
        if (result.error)
          throw new Error(
            `[${result.error.code ?? "ERR"}] ${result.error.message}`,
          );
        window.location.href = returnTo ?? "/";
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error)
          throw new Error(result.error.message ?? "Sign in failed");
        window.location.href = returnTo ?? (createOrgAfterSignIn ? "/setup?mode=new" : "/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SignInShell initialDesign={design}>
      <div className="eyebrow">YOUR NEXT SHOW STARTS HERE</div>
      <h1>
        {isSignUp ? (
          <>
            Your next great
            <br />
            show starts here.
          </>
        ) : (
          <>
            Good to have
            <br />
            you back.
          </>
        )}
      </h1>
      <p className="intro">
        {isSignUp
          ? "Create an account to bring your team together."
          : "Your team. Your cues. All in one place."}
      </p>
      <form onSubmit={handleSubmit}>
        {isSignUp && (
          <div className="name-field">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
        )}
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <div className="password-label">
          <label htmlFor="password">Password</label>
          {!isSignUp && <Link to="/forgot-password">Forgot password?</Link>}
        </div>
        <div className="password-field">
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete={isSignUp ? "new-password" : "current-password"}
            required
            minLength={isSignUp ? PASSWORD_MIN_LENGTH : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              isSignUp
                ? `At least ${PASSWORD_MIN_LENGTH} characters`
                : "Enter your password"
            }
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="eye size-10"
          >
            {showPassword ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
        {error && (
          <p className="signin-error" id="signin-error" role="alert">
            {error}
          </p>
        )}
        {existingAccount && (
          <button type="button" className="mb-4 min-h-11 underline underline-offset-4" onClick={() => {
            setIsSignUp(false);
            setCreateOrgAfterSignIn(true);
            setExistingAccount(false);
            setError(null);
            setPassword("");
          }}>Sign in to create an organization</button>
        )}
        <button
          type="submit"
          className="submit"
          disabled={loading}
          aria-busy={loading}
        >
          {loading
            ? isSignUp
              ? "Creating account…"
              : "Signing in…"
            : isSignUp
              ? "Create account"
              : "Sign in"}
          {loading ? (
            <LoaderCircle
              size={16}
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          ) : (
            <ArrowRight size={16} aria-hidden="true" />
          )}
        </button>
        {isSignUp && (
          <p className="legal">
            By creating an account you agree to the{" "}
            <Link to="/terms">Terms of Service</Link> and{" "}
            <Link to="/privacy">Privacy Policy</Link>.
          </p>
        )}
      </form>
      <p className="signup">
        {isSignUp ? "Already have an account?" : "New to ShowPilot?"}{" "}
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setIsSignUp(!isSignUp);
            if (existingAccount) setCreateOrgAfterSignIn(true);
            setExistingAccount(false);
            setError(null);
          }}
        >
          {isSignUp ? "Sign in instead" : "Create an account"}{" "}
          <span aria-hidden="true">↗</span>
        </button>
      </p>
    </SignInShell>
  );
}
