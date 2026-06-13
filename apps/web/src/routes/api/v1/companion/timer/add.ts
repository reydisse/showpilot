import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runCompanion } from "@/lib/companion-api";
import { timerAdd } from "@/lib/companion-control";

// Button 5 — add time to the running timer (default 60s).
const schema = z.object({ seconds: z.number().int().min(1).max(86400).default(60) });

export const Route = createFileRoute("/api/v1/companion/timer/add")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) => timerAdd(deps, orgId, body.seconds),
        }),
    },
  },
});
