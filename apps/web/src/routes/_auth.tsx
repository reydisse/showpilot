import { createFileRoute, Outlet, redirect, isRedirect, useRouterState } from "@tanstack/react-router";
import { getSessionWithOrg, listUserOrgs, setActiveOrg } from "@/lib/session";
import { AuthSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/_auth")({
  pendingComponent: AuthSkeleton,
  beforeLoad: async ({ location, abortController, preload }) => {
    const signal = abortController.signal;
    const result = await getSessionWithOrg({ signal }).catch(() => null);
    signal.throwIfAborted();

    // Session check failed — allow access to auth pages
    if (!result?.user) {
      return { user: null };
    }

    // Pages a logged-in user should still be able to reach directly.
    const allowsSignedInUser =
      location.pathname.startsWith("/setup") ||
      location.pathname.startsWith("/invitations") ||
      location.pathname.startsWith("/verify-email") ||
      location.pathname === "/reset-password" ||
      location.pathname === "/forgot-password";

    // If already logged in with an active org, redirect to their dashboard
    if (result.session.activeOrganizationId && result.org && !allowsSignedInUser) {
      throw redirect({ to: "/$slug", params: { slug: result.org.slug } });
    }

    // If logged in but no active org, try to auto-activate an existing one
    if (!allowsSignedInUser) {
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
    }

    return { user: result.user };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const isLogin = useRouterState({ select: (state) => state.location.pathname === "/login" });
  if (isLogin) return <Outlet />;
  return (
    <main
      className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-board-bg py-8 text-board-text"
      style={{
        backgroundImage:
          "radial-gradient(circle at top, color-mix(in srgb, var(--color-fire-500) 8%, transparent), transparent 42%)",
      }}
    >
      <div className="relative w-full max-w-md px-4">
        <Outlet />
      </div>
    </main>
  );
}
