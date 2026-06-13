import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { idSchema } from "@/lib/validation";
import { runCompanion } from "@/lib/companion-api";
import { timerStart } from "@/lib/companion-control";

// Button 1 — start / resume the timer (itemId optional → continues current).
const schema = z.object({ itemId: idSchema.optional() });

export const Route = createFileRoute("/api/v1/companion/timer/start")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) => timerStart(deps, orgId, body.itemId),
        }),
    },
  },
});
