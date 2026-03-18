import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionWithOrg, getUserInvitations } from "@/lib/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const result = await getSessionWithOrg();

    // If logged in with an active org, go to their dashboard
    if (result?.session.activeOrganizationId && result.org) {
      throw redirect({ to: `/${result.org.slug}` });
    }

    // If logged in but no org, check for pending invitations
    if (result?.user) {
      const invitations = await getUserInvitations();
      if (invitations.length > 0) {
        throw redirect({ to: "/invitations" });
      }
      throw redirect({ to: "/setup" });
    }

    // Not logged in, go to login
    throw redirect({ to: "/login" });
  },
});
