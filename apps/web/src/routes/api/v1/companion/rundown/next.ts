import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { rundownNext } from "@/lib/companion-control";

// Button 3 — advance to the next item.
export const Route = createFileRoute("/api/v1/companion/rundown/next")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => rundownNext(deps, orgId),
        }),
    },
  },
});
