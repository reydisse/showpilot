import { createFileRoute } from "@tanstack/react-router";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";
import { authenticateDisplayRequest } from "@/lib/display-access.server";
import { withPrimaryDatabase } from "@/lib/request-database.server";

export const handleOverlayGet = async ({
  params,
  request,
}: {
  params: { orgSlug: string };
  request: Request;
}) => withPrimaryDatabase(async () => {
  // Display clients do not share the publishing operator's write cookie.
  // Live output must not reappear from a lagging read replica after Clear.
  const prisma = getPrisma();
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };

  // Look up org by slug
  const org = await prisma.organization.findUnique({
    where: { slug: params.orgSlug },
  });
  if (!org) {
    return new Response("Display unavailable", { status: 404, headers });
  }
  if (!(await authenticateDisplayRequest(env.DB, request, org.id, "overlay", env.KIOSK_SECRET))) {
    return new Response("Display pass required", { status: 401, headers });
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
});

export const Route = createFileRoute("/api/overlay/$orgSlug")({
  server: { handlers: { GET: handleOverlayGet } },
});
