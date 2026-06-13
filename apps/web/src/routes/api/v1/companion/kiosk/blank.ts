import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runCompanion } from "@/lib/companion-api";
import { kioskBlank } from "@/lib/companion-control";

// Button 9 — blank / restore every kiosk display for the org (toggle on/off).
const schema = z.object({ blanked: z.boolean() });

export const Route = createFileRoute("/api/v1/companion/kiosk/blank")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) => kioskBlank(deps, orgId, body.blanked),
        }),
    },
  },
});
