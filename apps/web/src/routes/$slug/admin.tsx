import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const Route = createFileRoute("/$slug/admin")({
  pendingComponent: () => <PageSkeleton />,
  beforeLoad: async ({ params }) => {
    throw redirect({ to: "/$slug/team", params: { slug: params.slug } });
  },
});
