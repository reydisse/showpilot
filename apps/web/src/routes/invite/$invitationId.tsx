import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  getSession,
  getInvitationDetails,
  acceptInvitation,
  setActiveOrg,
} from "@/lib/session";

export const Route = createFileRoute("/invite/$invitationId")({
  loader: async ({ params }) => {
    const [session, invitation] = await Promise.all([
      getSession().catch(() => null),
      getInvitationDetails({ data: params.invitationId }),
    ]);
    return { session, invitation };
  },
  component: InvitePage,
});

function InvitePage() {
  const { session, invitation } = Route.useLoaderData();
  const navigate = useNavigate();
  const params = Route.useParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth form state (for unauthenticated users)
  const [isSignUp, setIsSignUp] = useState(true);
  const [email, setEmail] = useState(invitation?.email ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  if (!invitation) {
    return (
      <InviteShell>
        <div className="text-center">
          <div className="mb-4 text-4xl">🔗</div>
          <h2 className="text-xl font-semibold text-board-text mb-2">
            Invalid Invitation
          </h2>
          <p className="text-sm text-board-muted">
            This invitation link is invalid or has been removed.
          </p>
          <button
            onClick={() => navigate({ to: "/login" })}
            className="mt-6 text-sm text-fire-500 hover:underline"
          >
            Go to login
          </button>
        </div>
      </InviteShell>
    );
  }

  const isExpired = new Date(invitation.expiresAt) < new Date();
  const isUsed = invitation.status !== "pending";

  if (isExpired || isUsed) {
    return (
      <InviteShell>
        <div className="text-center">
          <div className="mb-4 text-4xl">{isExpired ? "⏰" : "✅"}</div>
          <h2 className="text-xl font-semibold text-board-text mb-2">
            {isExpired ? "Invitation Expired" : "Invitation Already Used"}
          </h2>
          <p className="text-sm text-board-muted">
            {isExpired
              ? "This invitation has expired. Ask your team admin to send a new one."
              : `This invitation has already been ${invitation.status}.`}
          </p>
          <button
            onClick={() => navigate({ to: "/login" })}
            className="mt-6 text-sm text-fire-500 hover:underline"
          >
            Go to login
          </button>
        </div>
      </InviteShell>
    );
  }

  async function handleAccept() {
    setLoading(true);
    setError(null);
    try {
      await acceptInvitation({ data: params.invitationId });
      await setActiveOrg({ data: invitation!.organizationId });
      navigate({ to: `/${invitation!.organization.slug}` });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to accept invitation"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleDecline() {
    navigate({ to: "/" });
  }

  async function handleAuthSubmit(e: React.FormEvent) {
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
      } else {
        const { error } = await authClient.signIn.email({
          email,
          password,
        });
        if (error) throw new Error(error.message);
      }
      // After auth, accept the invitation
      await acceptInvitation({ data: params.invitationId });
      await setActiveOrg({ data: invitation!.organizationId });
      navigate({ to: `/${invitation!.organization.slug}` });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Authentication failed"
      );
    } finally {
      setLoading(false);
    }
  }

  const orgName = invitation.organization.name;
  const inviterName = invitation.user?.name ?? "A team member";
  const roleName = invitation.role ?? "member";

  return (
    <InviteShell>
      {/* Invitation details */}
      <div className="text-center mb-6">
        <div className="mb-3 mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br from-fire-500/20 to-fire-700/20 border border-fire-500/20 flex items-center justify-center text-2xl font-bold text-fire-400">
          {orgName.charAt(0)}
        </div>
        <h2 className="text-xl font-semibold text-board-text">
          Join {orgName}
        </h2>
        <p className="text-sm text-board-muted mt-1">
          {inviterName} invited you as{" "}
          <span className="text-fire-400 font-medium">{roleName}</span>
        </p>
      </div>

      {session ? (
        /* Authenticated — show accept/decline */
        <div className="space-y-3">
          <p className="text-center text-sm text-board-muted">
            Signed in as{" "}
            <span className="text-board-text font-medium">
              {session.user.email}
            </span>
          </p>

          {error && <ErrorBanner message={error} />}

          <button
            onClick={handleAccept}
            disabled={loading}
            className="w-full rounded-xl px-4 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            style={{
              background:
                "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
            }}
          >
            {loading ? "Joining..." : "Accept & Join"}
          </button>
          <button
            onClick={handleDecline}
            disabled={loading}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-board-text transition-all duration-200 hover:border-red-500/30 hover:bg-red-500/5"
          >
            Decline
          </button>
        </div>
      ) : (
        /* Not authenticated — show login/signup form */
        <form onSubmit={handleAuthSubmit} className="space-y-4">
          <p className="text-center text-xs text-board-muted">
            {isSignUp
              ? "Create an account to join"
              : "Sign in to accept this invitation"}
          </p>

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

          {error && <ErrorBanner message={error} />}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl px-4 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            style={{
              background:
                "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
            }}
          >
            {loading
              ? "Joining..."
              : isSignUp
                ? "Create Account & Join"
                : "Sign In & Join"}
          </button>

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/[0.06]" />
            <span className="text-xs text-board-muted">
              {isSignUp
                ? "Already have an account?"
                : "New to ShowPilot?"}
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
        </form>
      )}
    </InviteShell>
  );
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
      <div className="w-full max-w-md px-4">
        <div className="animate-float-in">
          <div className="mb-8 flex flex-col items-center">
            <h1 className="text-3xl font-bold tracking-tight">
              <span className="text-fire-500">Show</span>
              <span className="text-board-text">Pilot</span>
            </h1>
          </div>

          <div
            className="rounded-2xl border border-white/[0.08] p-8 shadow-2xl backdrop-blur-xl"
            style={{
              background:
                "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5">
      <p className="text-sm text-red-300">{message}</p>
    </div>
  );
}
