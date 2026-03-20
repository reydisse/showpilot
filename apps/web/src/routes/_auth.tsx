import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionWithOrg, listUserOrgs, setActiveOrg } from "@/lib/session";
import { AuthSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/_auth")({
  pendingComponent: AuthSkeleton,
  beforeLoad: async ({ location }) => {
    let result;
    try {
      result = await getSessionWithOrg();
    } catch {
      // Session check failed — allow access to auth pages
      return { user: null };
    }

    const isSetupOrInvitations =
      location.pathname.startsWith("/setup") ||
      location.pathname.startsWith("/invitations");

    // If already logged in with an active org, redirect to their dashboard
    if (result?.session.activeOrganizationId && result.org && !isSetupOrInvitations) {
      throw redirect({ to: `/${result.org.slug}` });
    }

    // If logged in but no active org, try to auto-activate an existing one
    if (result?.user && !isSetupOrInvitations) {
      try {
        const orgs = await listUserOrgs();
        if (orgs && orgs.length > 0) {
          await setActiveOrg({ data: orgs[0].id });
          throw redirect({ to: `/${orgs[0].slug}` });
        }
      } catch (e) {
        if (e instanceof Error && "to" in e) throw e;
      }
    }

    return { user: result?.user ?? null };
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
