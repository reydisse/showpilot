import { RundownHandoffNotice } from "@/components/layout/RundownHandoffNotice";
import { getWorkspaceProfile } from "@/lib/workspace/profile";
import {
  WorkspaceProvider,
  WorkspaceRouteGate,
} from "@/components/workspace/WorkspaceProvider";
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
import { hasEffectivePermission } from "@/lib/app-permissions";
import { TimecodeProvider } from "@/components/timecode/TimecodeContext";

export const Route = createFileRoute("/$slug")({
  pendingComponent: OrgPending,
  beforeLoad: async ({ params, abortController, preload }) => {
    const signal = abortController.signal;
    const routeContext = await getOrgRouteContext({ data: params.slug, signal });
    signal.throwIfAborted();
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
    if (!preload && activeOrganizationId !== org.id) {
      try {
        await setActiveOrg({ data: org.id, signal });
      } catch {
        // Non-critical — role above does not depend on the active org
      }
    }
    signal.throwIfAborted();

    return {
      workspace: await getWorkspaceProfile({ data: { orgId: org.id }, signal }),
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
  return (
    <WorkspaceProvider profile={context.workspace}>
      <OrgContent />
    </WorkspaceProvider>
  );
}

function OrgContent() {
  const context = Route.useRouteContext();
  const matchRoute = useMatchRoute();
  const isBoard = matchRoute({ to: "/$slug/board" });
  const isCrewChat = matchRoute({ to: "/$slug/crew-chat" });
  const isCheckin = matchRoute({ to: "/$slug/checkin" });
  const isRundown = matchRoute({ to: "/$slug/rundown" });
  const standaloneRoute = isBoard || isCrewChat || isCheckin;
  const canUseTimecode = hasEffectivePermission(
    context.role,
    context.grantedPermissions,
    "timecode:access",
  );

  // Standalone routes — no sidebar, full screen
  if (standaloneRoute) {
    const wrapperClassName =
      "h-[100dvh] min-h-[100dvh] bg-board-bg " + (isBoard ? "overflow-hidden overscroll-none" : "overflow-auto");

    return (
      <ThemeProvider>
        <TimecodeProvider enabled={canUseTimecode} orgId={context.orgId}>
          <div className={wrapperClassName}>
            <div className="fixed inset-x-0 top-0 z-[80]">
              <RundownHandoffNotice orgId={context.orgId} slug={context.slug} />
            </div>
            <AccessGrantSyncController
            orgId={context.orgId}
            revision={context.accessRevision}
          />
            <WorkspaceRouteGate
              orgId={context.orgId}
              slug={context.slug}
              canManage={context.role === "owner" || context.role === "admin"}
            >
              <Outlet />
            </WorkspaceRouteGate>
          </div>
        </TimecodeProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <TimecodeProvider enabled={canUseTimecode} orgId={context.orgId}>
        <AppShell
        orgId={context.orgId}
        slug={context.slug}
        canControlRundown={hasEffectivePermission(
          context.role,
          context.grantedPermissions,
          "rundown:control",
        )}
        showLiveRundown={!isRundown}
      >
          <AccessGrantSyncController
            orgId={context.orgId}
            revision={context.accessRevision}
          />
          <WorkspaceRouteGate
            orgId={context.orgId}
            slug={context.slug}
            canManage={context.role === "owner" || context.role === "admin"}
          >
            <Outlet />
          </WorkspaceRouteGate>
        </AppShell>
      </TimecodeProvider>
    </ThemeProvider>
  );
}
