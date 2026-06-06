import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateKiosk,
  getRoster,
  kioskJson,
  kioskError,
} from "@/lib/kiosk-api";

// GET /api/v1/kiosk/roster?month=YYYY-MM — On-Duty roster. Read-only, kiosk token.
export const Route = createFileRoute("/api/v1/kiosk/roster")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = await authenticateKiosk(request);
        if ("error" in auth) {
          return kioskError(auth.error.code, auth.error.message, auth.error.status);
        }
        const month = new URL(request.url).searchParams.get("month");
        const data = await getRoster(auth.orgId, month);
        return kioskJson(data);
      },
    },
  },
});
