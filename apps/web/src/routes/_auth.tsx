import { createFileRoute, Outlet, redirect, isRedirect, useRouterState } from "@tanstack/react-router";
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
  const isLogin = useRouterState({ select: (state) => state.location.pathname === "/login" });
  return (
    <main
      className={`relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-board-bg py-8 text-board-text${isLogin ? " auth-signin" : ""}`}
      style={{
        backgroundImage:
          "radial-gradient(circle at top, color-mix(in srgb, var(--color-fire-500) 8%, transparent), transparent 42%)",
      }}
    >
      {isLogin && (
        <div className="auth-depth" aria-hidden="true">
          <AuthDepthCard side="left" />
          <AuthDepthCard side="right" />
        </div>
      )}
      <div className="relative w-full max-w-md px-4">
        <Outlet />
      </div>
    </main>
  );
}

function AuthDepthCard({ side }: { side: "left" | "right" }) {
  return (
    <div className={`auth-depth-stack auth-depth-${side}`}>
      <div className="auth-depth-layer" />
      <div className="auth-depth-layer" />
      <div className="auth-depth-layer">
        <div className="auth-depth-heading"><span /><span /></div>
        <div className="auth-depth-rows">
          {[0, 1, 2].map((row) => (
            <div className="auth-depth-row" key={row}>
              <span className="auth-depth-dot" />
              <span className="auth-depth-line" />
              <span className="auth-depth-time" />
            </div>
          ))}
        </div>
        <div className="auth-depth-track"><span /></div>
      </div>
    </div>
  );
}
