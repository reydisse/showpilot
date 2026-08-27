import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFileRoute } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { getPrisma } from "@/lib/db";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Content-Type": "image/svg+xml; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function renderCheckInQr(value: string) {
  return renderToStaticMarkup(createElement(QRCodeSVG, {
    bgColor: "#ffffff",
    fgColor: "#090909",
    includeMargin: true,
    level: "M",
    size: 256,
    title: "Crew check-in QR code",
    value,
  }));
}

export const Route = createFileRoute("/api/checkin-qr/$orgSlug")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { orgSlug: string }; request: Request }) => {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(params.orgSlug)) {
          return new Response("Not found", { status: 404 });
        }
        const organization = await getPrisma().organization.findUnique({
          where: { slug: params.orgSlug },
          select: { id: true },
        });
        if (!organization) return new Response("Not found", { status: 404 });

        const checkInUrl = `${new URL(request.url).origin}/checkin/${encodeURIComponent(params.orgSlug)}`;
        return new Response(renderCheckInQr(checkInUrl), { headers: responseHeaders });
      },
    },
  },
});
