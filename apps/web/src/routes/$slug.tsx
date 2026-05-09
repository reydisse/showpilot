import {
  createFileRoute,
  Outlet,
  redirect,
  useMatchRoute,
} from "@tanstack/react-router";
import {
  getSession,
  getOrgBySlug,
  setActiveOrg,
  getActiveMemberRole,
} from "@/lib/session";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/ThemeContext";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/$slug")({
  pendingComponent: OrgPending,
  beforeLoad: async ({ params }) => {
    let session;
    try {
      session = await getSession();
    } catch {
      throw redirect({ to: "/login" });
    }
    if (!session) {
      throw redirect({ to: "/login" });
    }

    const org = await getOrgBySlug({ data: params.slug });
    if (!org) {
      throw redirect({ to: "/login" });
    }

    if (session.session.activeOrganizationId !== org.id) {
      try {
        await setActiveOrg({ data: org.id });
      } catch {
        // Non-critical — continue with existing session
      }
    }

    let role = "member";
    try {
      role = (await getActiveMemberRole()) as string;
    } catch {
      // Fall back to member role
    }

    return {
      user: session.user,
      org,
      orgId: org.id,
      slug: params.slug,
      role,
    };
  },
  component: OrgLayout,
});

function OrgPending() {
  return (
    <ThemeProvider>
      <AppShell>
        <PageSkeleton />
      </AppShell>
    </ThemeProvider>
  );
}

function OrgLayout() {
  const matchRoute = useMatchRoute();
  const isBoard = matchRoute({ to: "/$slug/board" });
  const isCrewChat = matchRoute({ to: "/$slug/crew-chat" });
  const isCheckin = matchRoute({ to: "/$slug/checkin" });
  const standaloneRoute = isBoard || isCrewChat || isCheckin;

  // Standalone routes — no sidebar, full screen
  if (standaloneRoute) {
    const wrapperClassName =
      "h-[100dvh] min-h-[100dvh] bg-board-bg " + (isBoard ? "overflow-hidden overscroll-none" : "overflow-auto");

    return (
      <ThemeProvider>
        <div className={wrapperClassName}>
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
