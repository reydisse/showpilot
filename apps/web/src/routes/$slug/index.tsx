import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$slug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: `/${params.slug}/show` });
  },
});
