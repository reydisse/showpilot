import {
  createFileRoute,
  Outlet,
  redirect,
  useMatchRoute,
} from "@tanstack/react-router";
import { getOrgRouteContext, setActiveOrg } from "@/lib/session";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/ThemeContext";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { AccessGrantSyncController } from "@/components/layout/AccessGrantSyncController";

export const Route = createFileRoute("/$slug")({
  pendingComponent: OrgPending,
  beforeLoad: async ({ params }) => {
    let routeContext;
    try {
      routeContext = await getOrgRouteContext({ data: params.slug });
    } catch {
      throw redirect({ to: "/login" });
    }
    if (!routeContext) {
      throw redirect({ to: "/login" });
    }
    const {
      user,
      activeOrganizationId,
      org,
      memberRole,
      grantedPermissions,
      effectivePermissions,
      accessRevision,
      accessAuthority,
    } = routeContext;

    // Side effect: keep Better Auth's active org in sync with the visited
    // org so its other flows (invitations, etc.) stay consistent.
    if (activeOrganizationId !== org.id) {
      try {
        await setActiveOrg({ data: org.id });
      } catch {
        // Non-critical — role above does not depend on the active org
      }
    }

    return {
      user,
      org,
      orgId: org.id,
      slug: params.slug,
      role: memberRole,
      grantedPermissions,
      effectivePermissions,
      accessRevision,
      accessAuthority,
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
  const context = Route.useRouteContext();
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
          <AccessGrantSyncController
            orgId={context.orgId}
            revision={context.accessRevision}
          />
          <Outlet />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <AppShell>
        <AccessGrantSyncController
          orgId={context.orgId}
          revision={context.accessRevision}
        />
        <Outlet />
      </AppShell>
    </ThemeProvider>
  );
}
