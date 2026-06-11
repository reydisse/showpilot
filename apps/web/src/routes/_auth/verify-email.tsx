import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, XCircle, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { error } = Route.useSearch();
  const { user } = Route.useRouteContext() as {
    user: { email: string; emailVerified?: boolean } | null;
  };
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const failed = Boolean(error);

  async function handleResend() {
    if (!user?.email) return;
    setResending(true);
    setResendError(null);
    try {
      const { error: sendError } = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: "/verify-email",
      });
      if (sendError) throw new Error(sendError.message);
      setResent(true);
    } catch (err) {
      setResendError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setResending(false);
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
          Email verification
        </p>
      </div>

      <div
        className="rounded-2xl border border-white/[0.08] p-8 shadow-2xl backdrop-blur-xl text-center"
        style={{
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
        {failed ? (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/15 border-2 border-red-500/30">
              <XCircle className="h-7 w-7 text-red-400" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-board-text">
              Verification failed
            </h2>
            <p className="mb-6 text-sm text-board-muted">
              This verification link is invalid or has expired.
            </p>
            {user?.email ? (
              <div className="space-y-3">
                <button
                  onClick={handleResend}
                  disabled={resending || resent}
                  className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
                >
                  <Mail className="h-4 w-4" />
                  {resent ? "Email sent — check your inbox" : resending ? "Sending..." : "Resend verification email"}
                </button>
                {resendError && <p className="text-sm text-red-300">{resendError}</p>}
              </div>
            ) : (
              <Link to="/login" className="text-sm text-fire-500 hover:text-fire-400">
                Log in to request a new link
              </Link>
            )}
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 border-2 border-green-500/30">
              <CheckCircle2 className="h-7 w-7 text-green-400" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-board-text">
              Email verified
            </h2>
            <p className="mb-6 text-sm text-board-muted">
              You're all set. You can now create your organization and get your
              team on board.
            </p>
            <Link
              to="/setup"
              className="inline-block rounded-xl px-6 py-3 font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
            >
              Continue
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
