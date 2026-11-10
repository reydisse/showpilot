import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/$slug/dashboard/devices")({
  pendingComponent: PageSkeleton,
  beforeLoad: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "devices:access", params.slug, context.orgId);
  },
  component: Outlet,
});
