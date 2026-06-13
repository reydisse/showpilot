import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { rundownPrevious } from "@/lib/companion-control";

// Button 4 — step back to the previous item.
export const Route = createFileRoute("/api/v1/companion/rundown/previous")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => rundownPrevious(deps, orgId),
        }),
    },
  },
});
