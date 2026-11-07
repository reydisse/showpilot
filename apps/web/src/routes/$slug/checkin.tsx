import { createFileRoute } from "@tanstack/react-router";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { getCheckInMembers } from "@/lib/crew-attendance";
import { CrewCheckInPage } from "@/components/checkin/CrewCheckInPage";
export const Route = createFileRoute("/$slug/checkin")({
  pendingComponent: () => <BoardSkeleton />,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "checkin:access", context.slug, context.orgId);
    const members = await getCheckInMembers({ data: { orgId: context.orgId }, signal: abortController.signal });
    return { members, orgId: context.orgId, slug: context.slug };
  },
  component: CheckInPage,
});
function CheckInPage() {
  const { members, orgId, slug } = Route.useLoaderData();
  return <CrewCheckInPage key={orgId} initialMembers={members} orgId={orgId} slug={slug} />;
}
