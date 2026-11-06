import { createFileRoute, redirect } from "@tanstack/react-router";

// Old operator links use the same protected renderer as published display links.
export const Route = createFileRoute("/$slug/streaming/graphics/overlay")({
  beforeLoad: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "lowerthird:view", params.slug, context.orgId);
    throw redirect({ to: "/overlay/$orgSlug", params: { orgSlug: params.slug }, replace: true });
  },
});
