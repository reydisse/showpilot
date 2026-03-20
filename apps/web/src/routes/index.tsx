import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  getSessionWithOrg,
  getUserInvitations,
  listUserOrgs,
  setActiveOrg,
} from "@/lib/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    let result;
    try {
      result = await getSessionWithOrg();
    } catch {
      // Session check failed — send to login
      throw redirect({ to: "/login" });
    }

    // If logged in with an active org, go to their dashboard
    if (result?.session.activeOrganizationId && result.org) {
      throw redirect({ to: `/${result.org.slug}` });
    }

    // If logged in but no active org, try to auto-activate an existing org
    if (result?.user) {
      try {
        const orgs = await listUserOrgs();
        if (orgs && orgs.length > 0) {
          await setActiveOrg({ data: orgs[0].id });
          throw redirect({ to: `/${orgs[0].slug}` });
        }
      } catch (e) {
        // Re-throw redirects
        if (e instanceof Error && "to" in e) throw e;
      }

      // No orgs — check for pending invitations
      try {
        const invitations = await getUserInvitations();
        if (invitations.length > 0) {
          throw redirect({ to: "/invitations" });
        }
      } catch (e) {
        if (e instanceof Error && "to" in e) throw e;
      }

      // No orgs and no invitations — create first org
      throw redirect({ to: "/setup" });
    }

    // Not logged in, go to login
    throw redirect({ to: "/login" });
  },
});
