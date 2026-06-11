import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateKiosk,
  getAssets,
  kioskJson,
  kioskError,
} from "@/lib/kiosk-api";

// GET /api/v1/kiosk/assets — Asset Status board. Read-only, kiosk token.
export const Route = createFileRoute("/api/v1/kiosk/assets")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = await authenticateKiosk(request);
        if ("error" in auth) {
          return kioskError(auth.error.code, auth.error.message, auth.error.status);
        }
        const data = await getAssets(auth.orgId);
        return kioskJson(data);
      },
    },
  },
});
