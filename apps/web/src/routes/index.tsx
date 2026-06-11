import { createFileRoute, redirect, isRedirect } from "@tanstack/react-router";
import {
  getSessionWithOrg,
  getUserInvitations,
  listUserOrgs,
  setActiveOrg,
  getRequestHost,
} from "@/lib/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    // admin.showpilot.tech → go to /superadmin
    const host = await getRequestHost().catch(() => "");
    if (host.startsWith("admin.")) {
      throw redirect({ to: "/superadmin" });
    }

    const result = await getSessionWithOrg().catch(() => null);

    // Not logged in
    if (!result?.user) {
      throw redirect({ to: "/login" });
    }

    // Has an active org → go to dashboard
    if (result.session.activeOrganizationId && result.org) {
      throw redirect({ to: "/$slug", params: { slug: result.org.slug } });
    }

    // No active org → find one and activate it
    try {
      const orgs = await listUserOrgs();
      if (orgs && orgs.length > 0) {
        await setActiveOrg({ data: orgs[0].id });
        throw redirect({ to: "/$slug", params: { slug: orgs[0].slug } });
      }
    } catch (e) {
      if (isRedirect(e)) throw e;
    }

    // No orgs at all → check invitations
    try {
      const invitations = await getUserInvitations();
      if (invitations.length > 0) {
        throw redirect({ to: "/invitations" });
      }
    } catch (e) {
      if (isRedirect(e)) throw e;
    }

    // No orgs, no invitations → first-time setup
    throw redirect({ to: "/setup" });
  },
});
