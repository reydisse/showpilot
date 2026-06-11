import { createFileRoute } from "@tanstack/react-router";
import { getPrisma } from "@/lib/db";

export const Route = createFileRoute("/api/overlay/$orgSlug")({
  server: {
    handlers: {
      GET: async ({
        params,
      }: {
        params: { orgSlug: string };
      }) => {
        const prisma = getPrisma();
        const headers = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        };

        // Look up org by slug
        const org = await prisma.organization.findUnique({
          where: { slug: params.orgSlug },
        });
        if (!org) {
          return new Response(JSON.stringify([]), { headers });
        }

        // Read the active set (JSON list), falling back to the legacy single key.
        const multi = await prisma.appSetting.findUnique({
          where: { orgId_key: { orgId: org.id, key: "active-graphics" } },
        });
        let ids: string[] = [];
        if (multi?.value) {
          try {
            const arr = JSON.parse(multi.value);
            if (Array.isArray(arr)) ids = arr.filter((x): x is string => typeof x === "string");
          } catch {
            ids = [];
          }
        }
        if (ids.length === 0) {
          const legacy = await prisma.appSetting.findUnique({
            where: { orgId_key: { orgId: org.id, key: "active-graphic" } },
          });
          if (legacy?.value) ids = [legacy.value];
        }

        if (ids.length === 0) {
          return new Response(JSON.stringify([]), { headers });
        }

        // Fetch templates and return them in the stored display order.
        const rows = await prisma.graphicTemplate.findMany({
          where: { id: { in: ids }, orgId: org.id },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

        return new Response(JSON.stringify(ordered), { headers });
      },
    },
  },
});
