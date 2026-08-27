import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, CheckCircle2, Trash2 } from "lucide-react";
import { useState } from "react";
import { getAccountDeletionStatus } from "@/lib/account-deletion";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/delete-account")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    ...(typeof search.token === "string" && /^[A-Za-z0-9]{32}$/.test(search.token)
      ? { token: search.token }
      : {}),
  }),
  loader: () => getAccountDeletionStatus(),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const status = Route.useLoaderData();
  const { token } = Route.useSearch();
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = `/delete-account${token ? `?token=${token}` : ""}`;

  async function submitDeletion() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.deleteUser(token ? { token } : { callbackURL: "/account-deleted" });
      if (result.error) throw new Error(result.error.message ?? "Account deletion could not be completed");
      if (token) {
        window.location.href = "/account-deleted";
        return;
      }
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account deletion could not be completed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-board-bg px-5 py-10 text-board-text">
      <div className="mx-auto w-full max-w-xl">
        <Link to="/" className="text-xl font-bold tracking-tight"><span className="text-fire-500">Show</span>Pilot</Link>
        <section className="mt-8 rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl sm:p-8">
          <div className="flex size-11 items-center justify-center rounded-xl bg-red-500/10 text-red-400"><Trash2 className="size-5" /></div>
          <h1 className="mt-5 font-[family-name:var(--font-display)] text-2xl font-semibold">Delete your account</h1>

          {!status.signedIn ? (
            <>
              <p className="mt-3 text-sm leading-6 text-board-muted">Sign in to the account you want to delete. We will return you to this page.</p>
              <Link to="/login" search={{ returnTo }} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black">Sign in securely <ArrowRight className="size-4" /></Link>
            </>
          ) : status.blockers.length > 0 ? (
            <>
              <div className="mt-5 flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" />
                <div><p className="text-sm font-semibold">Transfer ownership first</p><p className="mt-1 text-xs leading-5 text-board-muted">You are the last owner of the workspaces below. Make another member an owner, or delete the workspace, before deleting your account.</p></div>
              </div>
              <div className="mt-4 space-y-2">{status.blockers.map((blocker) => (
                <Link key={blocker.id} to="/$slug/team" params={{ slug: blocker.slug }} className="flex items-center justify-between rounded-xl border border-board-border bg-board-bg/50 px-4 py-3 text-sm hover:border-fire-500/35"><span>{blocker.name}</span><span className="text-xs text-fire-400">Manage team</span></Link>
              ))}</div>
            </>
          ) : sent ? (
            <div className="mt-6 rounded-xl border border-green-500/25 bg-green-500/10 p-5">
              <CheckCircle2 className="size-6 text-green-400" />
              <h2 className="mt-3 text-sm font-semibold">Check your email</h2>
              <p className="mt-1 text-xs leading-5 text-board-muted">We sent a confirmation link to {status.email}. The link expires in 24 hours; your account remains active until you confirm.</p>
            </div>
          ) : (
            <>
              <p className="mt-3 text-sm leading-6 text-board-muted">This permanently removes your login, profile photo, memberships, personal notifications, push registrations, reactions, incident comments, and native chat content. Workspace data owned by other people remains.</p>
              {token ? (
                <div className="mt-6 rounded-xl border border-red-500/25 bg-red-500/10 p-4 text-sm">Your email is confirmed. One final click will permanently delete <strong>{status.email}</strong>.</div>
              ) : (
                <label className="mt-6 block text-xs font-medium uppercase tracking-wider text-board-muted">Type DELETE to continue
                  <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-base text-board-text outline-none focus:border-red-500/60" />
                </label>
              )}
              {error ? <p role="alert" className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}
              <button type="button" onClick={submitDeletion} disabled={submitting || (!token && confirmation !== "DELETE")} className="mt-5 w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-45">
                {submitting ? "Working…" : token ? "Permanently delete my account" : "Email me a confirmation link"}
              </button>
            </>
          )}
        </section>
        <div className="mt-6 flex flex-wrap gap-4 text-xs text-board-muted"><Link to="/privacy">Privacy Policy</Link><Link to="/support">Support</Link></div>
      </div>
    </main>
  );
}
