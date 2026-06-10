import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$slug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$slug/board", params: { slug: params.slug } });
  },
});
