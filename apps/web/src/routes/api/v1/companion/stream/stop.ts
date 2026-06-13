import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { streamStop } from "@/lib/companion-control";

// Button 10 (stop) — disconnect all simulcast destinations (Multi-Platform
// page's "Stop All").
export const Route = createFileRoute("/api/v1/companion/stream/stop")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => streamStop(deps, orgId),
        }),
    },
  },
});
