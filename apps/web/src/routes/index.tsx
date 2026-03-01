import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionWithOrg } from "@/lib/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const result = await getSessionWithOrg();

    // If logged in with an active org, go to their dashboard
    if (result?.session.activeOrganizationId && result.org) {
      throw redirect({ to: `/${result.org.slug}` });
    }

    // If logged in but no org, go to setup
    if (result?.user) {
      throw redirect({ to: "/setup" });
    }

    // Not logged in, go to login
    throw redirect({ to: "/login" });
  },
});
