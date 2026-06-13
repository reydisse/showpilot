import { createFileRoute } from "@tanstack/react-router";
import { runCompanion } from "@/lib/companion-api";
import { timerStop } from "@/lib/companion-control";

// Button 2 — stop the timer.
export const Route = createFileRoute("/api/v1/companion/timer/stop")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          handler: ({ orgId, deps }) => timerStop(deps, orgId),
        }),
    },
  },
});
