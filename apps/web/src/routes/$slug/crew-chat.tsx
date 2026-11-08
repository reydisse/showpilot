import { createFileRoute, redirect } from "@tanstack/react-router";

// Signed-in crew use the same Production Chat as the rest of the workspace.
// Guest QR passes retain their separate scoped /join/chat/:token entry point.
export const Route = createFileRoute("/$slug/crew-chat")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$slug/chat",
      params: { slug: params.slug },
      search: { room: "production", message: undefined },
      replace: true,
    });
  },
});
