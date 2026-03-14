import {
  createFileRoute,
  Outlet,
  redirect,
  useMatchRoute,
} from "@tanstack/react-router";
import { getSession, getOrgBySlug, setActiveOrg } from "@/lib/session";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/ThemeContext";

export const Route = createFileRoute("/$slug")({
  beforeLoad: async ({ params }) => {
    // 1. Check session — redirect to login if not authenticated
    const session = await getSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }

    // 2. Validate the slug matches a real org
    const org = await getOrgBySlug({ data: params.slug });
    if (!org) {
      throw redirect({ to: "/login" });
    }

    // 3. Set this org as active if it isn't already
    if (session.session.activeOrganizationId !== org.id) {
      await setActiveOrg({ data: org.id });
    }

    return {
      user: session.user,
      org,
      orgId: org.id,
      slug: params.slug,
    };
  },
  component: OrgLayout,
});

function OrgLayout() {
  const matchRoute = useMatchRoute();
  const isBoard = matchRoute({ to: "/$slug/board" });

  if (isBoard) {
    return (
      <ThemeProvider>
        <div className="h-screen bg-board-bg overflow-auto">
          <Outlet />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </ThemeProvider>
  );
}
