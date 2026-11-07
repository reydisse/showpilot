import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { SignInShell } from "@/components/auth/SignInShell";
import { getSignInDesign } from "@showpilot/shared";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_MIN_LENGTH } from "@showpilot/shared";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { safeAuthReturnTo, verificationHref } from "@/lib/auth-navigation";

export const Route = createFileRoute("/_auth/login")({
  validateSearch: (search: Record<string, unknown>): { signup?: 1; verify?: 1; returnTo?: string } => ({
    signup: search.signup === "1" || search.signup === 1 ? 1 : undefined,
    verify: search.verify === "1" || search.verify === 1 ? 1 : undefined,
    returnTo: safeAuthReturnTo(search.returnTo),
  }),
  loader: () => ({ design: getSignInDesign(new Date()) }),
  component: LoginPage,
});

function LoginPage() {
  const { signup, verify, returnTo } = Route.useSearch();
  const { design } = Route.useLoaderData();
  const [isSignUp, setIsSignUp] = useState(Boolean(signup));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<{ message: string; at: number } | null>(null);
  const [uncertainSignup, setUncertainSignup] = useState(false);
  const [verifyAfterSignIn, setVerifyAfterSignIn] = useState(Boolean(verify));
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const [loading, setLoading] = useState(false);
  const [existingAccount, setExistingAccount] = useState(false);
  const [createOrgAfterSignIn, setCreateOrgAfterSignIn] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (request.current) return;
    const signingUp = isSignUp;
    // HTTP redirects cannot see a fragment. Browsers carry it onto the login
    // URL; put it back on the app destination before navigating or emailing.
    const destination = safeAuthReturnTo(returnTo && !returnTo.includes("#") ? returnTo + window.location.hash : returnTo);
    const controller = new AbortController();
    request.current = controller;
    setError(null); setExistingAccount(false); setUncertainSignup(false); setLoading(true);
    const fail = (message: string) => setError({ message, at: Date.now() });
    try {
      const fetchOptions = { signal: controller.signal, retry: 0 };
      const operation = signingUp
        ? authClient.signUp.email({ email, password, name, callbackURL: verificationHref(destination), fetchOptions })
        : authClient.signIn.email({ email, password, fetchOptions });
      const result = await withOperationTimeout(operation, 8_000, "Authentication confirmation timed out.");
      if (controller.signal.aborted) return;
      if (result.error) {
        const code = result.error.code;
        if (signingUp && (code === "USER_ALREADY_EXISTS" || code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")) {
          setExistingAccount(true);
          fail("An account with this email already exists. Sign in to create another organization.");
          return;
        }
        const message = code === "PASSWORD_TOO_SHORT" ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
          : code === "PASSWORD_TOO_LONG" ? "Use no more than 128 characters."
          : code === "INVALID_EMAIL" ? "Enter a valid email address."
          : !signingUp && code === "INVALID_EMAIL_OR_PASSWORD" ? "The email or password is incorrect. Check your details and try again."
          : !signingUp && code === "EMAIL_NOT_VERIFIED" ? "Verify your email before signing in. Open the link in your inbox."
          : result.error.status === 429 ? "Too many attempts. Wait a minute, then try again." : null;
        if (message) { fail(message); return; }
        throw new Error("Authentication outcome unavailable.");
      }
      if (!result.data?.user || !result.data.token) throw new Error("Authentication acknowledgement missing.");
      setPassword("");
      window.location.href = signingUp || verifyAfterSignIn ? verificationHref(destination) : destination ?? (createOrgAfterSignIn ? "/setup?mode=new" : "/");
    } catch {
      if (controller.signal.aborted) return;
      setUncertainSignup(signingUp);
      fail(signingUp
        ? "We couldn't confirm account creation. Your account may already exist. Sign in with these details to continue, or retry creating the account."
        : "We couldn't confirm sign-in. Check your connection and try signing in again.");
    } finally {
      controller.abort();
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }

  function recoverBySigningIn(forVerification: boolean) {
    setIsSignUp(false); setVerifyAfterSignIn(forVerification); setCreateOrgAfterSignIn(!forVerification);
    setExistingAccount(false); setUncertainSignup(false); setError(null); setPassword("");
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
      <form onSubmit={handleSubmit} aria-busy={loading}>
        {isSignUp && (
          <div className="name-field">
            <label htmlFor="name">Full name</label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              required
              disabled={loading}
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
          disabled={loading}
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
            disabled={loading}
            maxLength={isSignUp ? 128 : undefined}
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
            className="eye size-11"
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
            {error.message}<span className="block">Last attempt: {new Date(error.at).toLocaleTimeString()}</span>
          </p>
        )}
        {existingAccount && <button type="button" className="mb-4 min-h-11 underline underline-offset-4" onClick={() => recoverBySigningIn(false)}>Sign in to create an organization</button>}
        {uncertainSignup && <button type="button" className="mb-4 min-h-11 underline underline-offset-4" onClick={() => recoverBySigningIn(true)}>Sign in to check account</button>}
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
              ? uncertainSignup ? "Retry creating account" : "Create account"
              : error ? "Retry sign-in" : "Sign in"}
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
            if (uncertainSignup) setVerifyAfterSignIn(true);
            setUncertainSignup(false);
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
