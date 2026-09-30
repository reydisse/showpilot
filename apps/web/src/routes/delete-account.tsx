import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { getAccountDeletionStatus } from "@/lib/account-deletion";
import { authClient } from "@/lib/auth-client";
import { deleteOrganization } from "@/lib/org-deletion";
import type { AccountDeletionOwnershipBlocker } from "@/lib/account-deletion-core";

export const Route = createFileRoute("/delete-account")({
  loader: () => getAccountDeletionStatus(),
  component: DeleteAccountPage,
});

function DeleteAccountPage() {
  const status = Route.useLoaderData();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnTo = "/delete-account";

  async function submitDeletion() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await authClient.deleteUser({ password });
      if (result.error?.code === "INVALID_PASSWORD") {
        setError("That password is incorrect. Your account has not been deleted. Try again or reset your password.");
        return;
      }
      if (result.error) throw new Error(result.error.message ?? "Account deletion could not be completed");
      window.location.href = "/account-deleted";
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "Account deletion could not be confirmed"}. Please retry. If cleanup started, some data may already have been removed.`);
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
                <div><p className="text-sm font-semibold">Choose what happens to your workspaces</p><p className="mt-1 text-xs leading-5 text-board-muted">You are the last owner of these workspaces. Transfer ownership to keep a workspace for your team, or delete it here to continue. Deleting a workspace removes its shared data for everyone and cancels its ShowPilot subscription.</p></div>
              </div>
              <div className="mt-4 space-y-4">{status.blockers.map((blocker) => (
                <WorkspaceDeletion key={blocker.id} workspace={blocker} onDeleted={() => router.invalidate()} />
              ))}</div>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm leading-6 text-board-muted">This permanently removes your login, profile photo, memberships, personal notifications, push registrations, crew contact details, personal preferences, reactions, incident comments, and native chat content. Workspace data owned by other people remains.</p>
              <label className="mt-6 block text-sm font-medium">Your ShowPilot password
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-base text-board-text outline-none focus:border-red-500/60" />
              </label>
              <Link to="/forgot-password" className="mt-2 inline-block text-sm text-fire-400">Forgot your password?</Link>
              <label className="mt-4 block text-sm font-medium">Type DELETE to confirm
                <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-base text-board-text outline-none focus:border-red-500/60" />
              </label>
              {error ? <p role="alert" className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}
              <button type="button" onClick={submitDeletion} disabled={submitting || confirmation !== "DELETE" || !password} className="mt-5 w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-45">
                {submitting ? "Deleting…" : "Permanently delete my account"}
              </button>
            </>
          )}
        </section>
        <div className="mt-6 flex flex-wrap gap-4 text-xs text-board-muted"><Link to="/privacy">Privacy Policy</Link><Link to="/support">Support</Link></div>
      </div>
    </main>
  );
}

function WorkspaceDeletion({ workspace, onDeleted }: {
  workspace: AccountDeletionOwnershipBlocker;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteOrganization({ data: { orgId: workspace.id, confirmName: name, continueAccountDeletion: true } });
      await onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace deletion failed. Please retry.");
    } finally {
      setBusy(false);
    }
  }
  return <div className="rounded-xl border border-board-border bg-board-bg/50 p-4">
    <h2 className="font-semibold">{workspace.name}</h2>
    <Link to="/$slug/team" params={{ slug: workspace.slug }} className="mt-2 inline-block text-sm text-fire-400">Transfer ownership to a team member</Link>
    <p className="mt-4 text-sm text-board-muted">To permanently delete this workspace and all its shared data, type <strong>{workspace.name}</strong>.</p>
    <label className="mt-3 block text-sm">Workspace name
      <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-base outline-none focus:border-red-500/60" />
    </label>
    {error ? <p role="alert" className="mt-3 text-sm text-red-300">{error} <Link to="/login" search={{ returnTo: "/delete-account" }} className="underline">Sign in again</Link></p> : null}
    <button type="button" onClick={remove} disabled={busy || name !== workspace.name} className="mt-4 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-45">{busy ? "Deleting workspace…" : "Delete workspace and continue"}</button>
  </div>;
}
