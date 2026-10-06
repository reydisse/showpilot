import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$slug/")({
  beforeLoad: ({ params, context }) => {
    throw redirect({
      to: context.workspace.modules.includes("board") ? "/$slug/board" : "/$slug/show",
      params: { slug: params.slug },
    });
  },
});
