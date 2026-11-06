import { createFileRoute, redirect, isRedirect } from "@tanstack/react-router";
import {
  getSessionWithOrg,
  getUserInvitations,
  listUserOrgs,
  setActiveOrg,
  getRequestHost,
} from "@/lib/session";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ abortController, preload }) => {
    const signal = abortController.signal;
    // admin.showpilot.tech → go to /superadmin
    const host = await getRequestHost({ signal }).catch(() => "");
    signal.throwIfAborted();
    if (host.startsWith("admin.")) {
      throw redirect({ to: "/superadmin" });
    }

    const result = await getSessionWithOrg({ signal }).catch(() => null);
    signal.throwIfAborted();

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
      const orgs = await listUserOrgs({ signal });
      signal.throwIfAborted();
      if (orgs && orgs.length > 0) {
        if (!preload) await setActiveOrg({ data: orgs[0].id, signal });
        signal.throwIfAborted();
        throw redirect({ to: "/$slug", params: { slug: orgs[0].slug } });
      }
    } catch (e) {
      signal.throwIfAborted();
      if (isRedirect(e)) throw e;
    }

    // No orgs at all → check invitations
    try {
      const invitations = await getUserInvitations({ signal });
      signal.throwIfAborted();
      if (invitations.length > 0) {
        throw redirect({ to: "/invitations" });
      }
    } catch (e) {
      signal.throwIfAborted();
      if (isRedirect(e)) throw e;
    }

    // No orgs, no invitations → first-time setup
    throw redirect({ to: "/setup" });
  },
});
