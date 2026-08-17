import { createFileRoute } from "@tanstack/react-router";
import { getCrewScheduleCalendar } from "@/lib/crew-schedule";

export const Route = createFileRoute("/api/crew/schedule/$token/calendar")({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { token: string } }) => {
        try {
          const assignmentId = new URL(request.url).searchParams.get("assignment") ?? "";
          const calendar = await getCrewScheduleCalendar(params.token, assignmentId);
          return new Response(calendar.content, {
            headers: {
              "Content-Type": "text/calendar; charset=utf-8",
              "Content-Disposition": `attachment; filename="${calendar.filename}"`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("Calendar invitation not found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
      },
    },
  },
});
