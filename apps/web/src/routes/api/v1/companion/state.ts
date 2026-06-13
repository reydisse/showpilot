import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { getState } from "@/lib/companion-control";

// GET /state — timer + active/next item + LT state + lyrics + kiosk blank +
// stream status, for Stream Deck button feedback.
export const Route = createFileRoute("/api/v1/companion/state")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => getState(deps, orgId),
        }),
    },
  },
});
