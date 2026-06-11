import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { MailWarning } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/setup")({
  component: SetupPage,
});

function SetupPage() {
  const { user } = Route.useRouteContext() as {
    user: { email: string; emailVerified?: boolean } | null;
  };
  const needsVerification = Boolean(user && !user.emailVerified);
  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);

  async function handleResendVerification() {
    if (!user?.email) return;
    setSendingVerification(true);
    setError(null);
    try {
      const { error: sendError } = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: "/verify-email",
      });
      if (sendError) throw new Error(sendError.message);
      setVerificationSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSendingVerification(false);
    }
  }

  function handleNameChange(value: string) {
    setOrgName(value);
    // Auto-generate slug from name
    setSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Create the organization
      const { error: createError } =
        await authClient.organization.create({
          name: orgName,
          slug,
        });
      if (createError) throw new Error(createError.message);

      // Set it as active
      const { error: setActiveError } =
        await authClient.organization.setActive({
          organizationSlug: slug,
        });
      if (setActiveError) throw new Error(setActiveError.message);

      // Full reload to pick up the updated session
      window.location.href = `/${slug}`;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create organization"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-float-in">
      <div className="mb-8 flex flex-col items-center">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-fire-500">Show</span>
          <span className="text-board-text">Pilot</span>
        </h1>
        <p className="mt-1 text-sm tracking-widest uppercase text-board-muted">
          Set up your organization
        </p>
      </div>

      <div
        className="rounded-2xl border border-white/[0.08] p-8 shadow-2xl backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
        <h2 className="mb-2 text-center text-xl font-semibold text-board-text">
          Create your team
        </h2>
        <p className="mb-6 text-center text-sm text-board-muted">
          This is your production team workspace.
        </p>

        {needsVerification && (
          <div className="mb-5 rounded-xl border border-fire-500/25 bg-fire-500/10 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-fire-500" />
              <div>
                <p className="text-sm text-board-text">
                  Verify your email to create an organization. We sent a link to{" "}
                  <strong>{user?.email}</strong>.
                </p>
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={sendingVerification || verificationSent}
                  className="mt-1.5 text-sm font-medium text-fire-500 hover:text-fire-400 disabled:pointer-events-none disabled:opacity-60"
                >
                  {verificationSent
                    ? "Email sent — check your inbox"
                    : sendingVerification
                      ? "Sending..."
                      : "Resend verification email"}
                </button>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="group">
            <label
              htmlFor="orgName"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
            >
              Organization Name
            </label>
            <input
              id="orgName"
              type="text"
              required
              value={orgName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Grace Community Church"
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:bg-white/[0.05] focus:ring-1 focus:ring-fire-500/20"
            />
          </div>

          <div className="group">
            <label
              htmlFor="slug"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
            >
              URL Slug
            </label>
            <input
              id="slug"
              type="text"
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="grace-community"
              pattern="[a-z0-9-]+"
              className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:bg-white/[0.05] focus:ring-1 focus:ring-fire-500/20"
            />
            <p className="mt-1 text-xs text-board-muted/60">
              Letters, numbers, and hyphens only
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !orgName || !slug || needsVerification}
            className="relative mt-2 w-full overflow-hidden rounded-xl px-4 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            style={{
              background:
                "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
            }}
          >
            {loading ? "Creating..." : "Create & Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
