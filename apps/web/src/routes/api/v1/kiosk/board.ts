import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateKiosk,
  getCrewBoard,
  kioskJson,
  kioskError,
} from "@/lib/kiosk-api";

// GET /api/v1/kiosk/board — Show Board (crew check-in status). Read-only, kiosk token.
export const Route = createFileRoute("/api/v1/kiosk/board")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = await authenticateKiosk(request);
        if ("error" in auth) {
          return kioskError(auth.error.code, auth.error.message, auth.error.status);
        }
        const data = await getCrewBoard(auth.orgId);
        return kioskJson(data);
      },
    },
  },
});
