import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$slug/admin")({
  beforeLoad: async ({ params }) => {
    throw redirect({ to: `/${params.slug}/team` });
  },
});
