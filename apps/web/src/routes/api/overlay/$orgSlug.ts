import { createFileRoute } from "@tanstack/react-router";
import { getPrisma } from "@/lib/db";

export const Route = createFileRoute("/api/overlay/$orgSlug")({
  server: {
    handlers: {
      GET: async ({
        request,
        params,
      }: {
        request: Request;
        params: { orgSlug: string };
      }) => {
        const prisma = getPrisma();

        // Look up org by slug
        const org = await prisma.organization.findUnique({
          where: { slug: params.orgSlug },
        });
        if (!org) {
          return new Response(JSON.stringify(null), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Check active-graphic
        const setting = await prisma.appSetting.findUnique({
          where: { orgId_key: { orgId: org.id, key: "active-graphic" } },
        });
        if (!setting) {
          return new Response(JSON.stringify(null), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Get the template
        const template = await prisma.graphicTemplate.findUnique({
          where: { id: setting.value },
        });

        return new Response(JSON.stringify(template), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
