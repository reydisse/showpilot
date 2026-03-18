import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  getUserInvitations,
  acceptInvitation,
  rejectInvitation,
  setActiveOrg,
} from "@/lib/session";

export const Route = createFileRoute("/_auth/invitations")({
  loader: async () => {
    const invitations = await getUserInvitations();
    return { invitations };
  },
  component: InvitationsPage,
});

function InvitationsPage() {
  const { invitations } = Route.useLoaderData();
  const navigate = useNavigate();

  if (invitations.length === 0) {
    return (
      <div className="animate-float-in text-center">
        <p className="text-board-muted mb-4">No pending invitations.</p>
        <button
          onClick={() => navigate({ to: "/setup" })}
          className="text-sm text-fire-500 hover:underline"
        >
          Create your own organization
        </button>
      </div>
    );
  }

  return (
    <div className="animate-float-in">
      <div className="mb-8 flex flex-col items-center">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="text-fire-500">Show</span>
          <span className="text-board-text">Pilot</span>
        </h1>
        <p className="mt-1 text-sm tracking-widest uppercase text-board-muted">
          Your Invitations
        </p>
      </div>

      <div
        className="rounded-2xl border border-white/[0.08] p-6 shadow-2xl backdrop-blur-xl"
        style={{
          background:
            "linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        }}
      >
        <p className="text-sm text-board-muted mb-4 text-center">
          You have been invited to join {invitations.length} organization
          {invitations.length !== 1 ? "s" : ""}
        </p>

        <div className="space-y-3">
          {invitations.map((inv) => (
            <InvitationRow
              key={inv.id}
              invitation={inv}
              onAccepted={(orgSlug) => navigate({ to: `/${orgSlug}` })}
            />
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-white/[0.06] text-center">
          <button
            onClick={() => navigate({ to: "/setup" })}
            className="text-sm text-board-muted hover:text-board-text transition-colors"
          >
            Or create your own organization
          </button>
        </div>
      </div>
    </div>
  );
}

function InvitationRow({
  invitation,
  onAccepted,
}: {
  invitation: {
    id: string;
    role: string | null;
    organization: { id: string; name: string; slug: string; logo: string | null };
  };
  onAccepted: (slug: string) => void;
}) {
  const [loading, setLoading] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  async function handleAccept() {
    setLoading("accept");
    setError(null);
    try {
      await acceptInvitation({ data: invitation.id });
      await setActiveOrg({ data: invitation.organization.id });
      onAccepted(invitation.organization.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept");
    } finally {
      setLoading(null);
    }
  }

  async function handleDecline() {
    setLoading("decline");
    try {
      await rejectInvitation({ data: invitation.id });
      setDismissed(true);
    } catch {
      setError("Failed to decline");
    } finally {
      setLoading(null);
    }
  }

  const org = invitation.organization;

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-board-border bg-board-card/50">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-fire-500/20 to-fire-700/20 border border-fire-500/20 flex items-center justify-center shrink-0">
        {org.logo ? (
          <img src={org.logo} alt={org.name} className="w-full h-full rounded-xl object-cover" />
        ) : (
          <span className="text-sm font-bold text-fire-400">
            {org.name.charAt(0)}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-board-text truncate">
          {org.name}
        </p>
        <p className="text-xs text-board-muted">
          Role: <span className="text-fire-400">{invitation.role ?? "member"}</span>
        </p>
        {error && <p className="text-xs text-red-400 mt-0.5">{error}</p>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleDecline}
          disabled={loading !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-muted border border-white/[0.08] hover:border-red-500/30 hover:text-red-400 transition-colors disabled:opacity-50"
        >
          {loading === "decline" ? "..." : "Decline"}
        </button>
        <button
          onClick={handleAccept}
          disabled={loading !== null}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
          }}
        >
          {loading === "accept" ? "..." : "Join"}
        </button>
      </div>
    </div>
  );
}
