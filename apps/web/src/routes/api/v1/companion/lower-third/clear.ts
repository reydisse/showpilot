import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { clearLowerThird } from "@/lib/companion-control";

// Button 11 — clear the active lower third (blocked unless Cloud Graphics is enabled).
export const Route = createFileRoute("/api/v1/companion/lower-third/clear")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => clearLowerThird(deps, orgId),
        }),
    },
  },
});
