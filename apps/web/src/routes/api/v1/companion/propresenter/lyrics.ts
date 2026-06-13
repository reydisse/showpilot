import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { runCompanion } from "@/lib/companion-api";
import { setLyrics } from "@/lib/companion-control";

// Buttons 7 (on) / 8 (off) — toggle ProPresenter lyrics-on-timer.
const schema = z.object({ enabled: z.boolean() });

export const Route = createFileRoute("/api/v1/companion/propresenter/lyrics")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        runCompanion({
          request,
          schema,
          handler: ({ orgId, body, deps }) => setLyrics(deps, orgId, body.enabled),
        }),
    },
  },
});
