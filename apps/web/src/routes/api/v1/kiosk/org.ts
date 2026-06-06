import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateKiosk,
  getOrgStructure,
  kioskJson,
  kioskError,
} from "@/lib/kiosk-api";

// GET /api/v1/kiosk/org — Org Chart (director + teams). Read-only, kiosk token.
export const Route = createFileRoute("/api/v1/kiosk/org")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = await authenticateKiosk(request);
        if ("error" in auth) {
          return kioskError(auth.error.code, auth.error.message, auth.error.status);
        }
        const data = await getOrgStructure(auth.orgId);
        if (!data) return kioskError("not_found", "Organization not found", 404);
        return kioskJson(data);
      },
    },
  },
});
