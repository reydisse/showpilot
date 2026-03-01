import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionWithOrg } from "@/lib/session";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async () => {
    // If already logged in with an active org, redirect to their dashboard
    const result = await getSessionWithOrg();
    if (result?.session.activeOrganizationId && result.org) {
      throw redirect({ to: `/${result.org.slug}` });
    }
    // If logged in but no org, allow access to /setup
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
