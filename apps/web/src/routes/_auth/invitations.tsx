import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { InvitationResponseCard } from "@/components/invitations/InvitationResponseCard";
import { getUserInvitations } from "@/lib/session";

export const Route = createFileRoute("/_auth/invitations")({
  loader: async ({ abortController }) => ({ invitations: await getUserInvitations({ signal: abortController.signal }) }),
  component: InvitationsPage,
});

function InvitationsPage() {
  const { invitations } = Route.useLoaderData();
  const navigate = useNavigate();
  return <div className="min-w-0 space-y-4">
    <h1 className="text-center text-2xl font-semibold text-board-text">Your invitations</h1>
    {invitations.length === 0 && <p className="text-center text-board-muted">No pending invitations.</p>}
    {invitations.map(invitation => <InvitationResponseCard key={invitation.id} invitationId={invitation.id}
      initial={invitation.emailVerified ? {
        status: new Date(invitation.expiresAt).getTime() <= Date.now() ? "expired" : "pending",
        email: invitation.email,
        invitation: { id: invitation.id, role: invitation.role ?? "member", expiresAt: new Date(invitation.expiresAt).getTime(), organization: invitation.organization },
      } : { status: "unverified", email: invitation.email }}
      navigate={href => navigate({ href })} />)}
    <a href="/setup" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-board-border px-4 py-3 text-sm text-board-text">Create your own workspace</a>
  </div>;
}
