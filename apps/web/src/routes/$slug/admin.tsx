import { createFileRoute } from "@tanstack/react-router";
import { getCrewMembers } from "@/lib/data";
import { MemberTable } from "@/components/admin/MemberTable";
import type { Member } from "@/types";

export const Route = createFileRoute("/$slug/admin")({
  loader: async ({ context }) => {
    const members = await getCrewMembers({ data: { orgId: context.orgId } });
    return { members: members as Member[], orgId: context.orgId };
  },
  component: AdminPage,
});

function AdminPage() {
  const { members, orgId } = Route.useLoaderData();

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <MemberTable members={members} orgId={orgId} />
    </div>
  );
}
