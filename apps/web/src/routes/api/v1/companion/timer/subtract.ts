import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runCompanion } from "@/lib/companion-api";
import { timerSubtract } from "@/lib/companion-control";

// Button 6 — subtract time from the running timer (default 60s).
const schema = z.object({ seconds: z.number().int().min(1).max(86400).default(60) });

export const Route = createFileRoute("/api/v1/companion/timer/subtract")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) => timerSubtract(deps, orgId, body.seconds),
        }),
    },
  },
});
