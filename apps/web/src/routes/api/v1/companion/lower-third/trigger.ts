import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runCompanion } from "@/lib/companion-api";
import { triggerLowerThird } from "@/lib/companion-control";
import { lowerThirdPayloadSchema } from "@/lib/lowerthirds";

// Button 11 — trigger a lower third (blocked unless Cloud Graphics is enabled).
const schema = z.object({
  payload: lowerThirdPayloadSchema,
  triggeredBy: z.string().max(200).optional(),
});

export const Route = createFileRoute("/api/v1/companion/lower-third/trigger")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) =>
            triggerLowerThird(deps, orgId, body.payload, body.triggeredBy ?? "companion"),
        }),
    },
  },
});
