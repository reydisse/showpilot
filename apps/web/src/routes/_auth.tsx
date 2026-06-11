import { createFileRoute, Outlet, redirect, isRedirect } from "@tanstack/react-router";
import { getSessionWithOrg, listUserOrgs, setActiveOrg } from "@/lib/session";
import { AuthSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/_auth")({
  pendingComponent: AuthSkeleton,
  beforeLoad: async ({ location }) => {
    const result = await getSessionWithOrg().catch(() => null);

    // Session check failed — allow access to auth pages
    if (!result?.user) {
      return { user: null };
    }

    // Pages a logged-in user should still be able to reach directly.
    const isSetupOrInvitations =
      location.pathname.startsWith("/setup") ||
      location.pathname.startsWith("/invitations") ||
      location.pathname.startsWith("/verify-email");

    // If already logged in with an active org, redirect to their dashboard
    if (result.session.activeOrganizationId && result.org && !isSetupOrInvitations) {
      throw redirect({ to: "/$slug", params: { slug: result.org.slug } });
    }

    // If logged in but no active org, try to auto-activate an existing one
    if (!isSetupOrInvitations) {
      try {
        const orgs = await listUserOrgs();
        if (orgs && orgs.length > 0) {
          await setActiveOrg({ data: orgs[0].id });
          throw redirect({ to: "/$slug", params: { slug: orgs[0].slug } });
        }
      } catch (e) {
        if (isRedirect(e)) throw e;
      }
    }

    return { user: result.user };
  },
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
      <div className="w-full max-w-md px-4">
        <Outlet />
      </div>
    </div>
  );
}
