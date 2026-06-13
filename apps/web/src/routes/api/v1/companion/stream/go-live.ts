import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { streamGoLive } from "@/lib/companion-control";

// Button 10 — connect the org's enabled simulcast destinations to its live
// input (the same action as the Multi-Platform page's "Go Live"). Returns
// per-destination success/failure; 409 when no live input is configured.
//
// NOTE: this connects ShowPilot's simulcast outputs. YouTube/Facebook/etc.
// must still be set to "Go Live" on the platform's own end first.
export const Route = createFileRoute("/api/v1/companion/stream/go-live")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => streamGoLive(deps, orgId),
        }),
    },
  },
});
