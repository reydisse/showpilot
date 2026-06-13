import { createFileRoute } from "@tanstack/react-router";
import { authenticateKiosk, getKioskDisplay, kioskJson, kioskError } from "@/lib/kiosk-api";

// GET /api/v1/kiosk/display — display command (blank flag). Read-only, kiosk
// token. Kiosk clients poll this alongside org/roster/assets and show a black
// slate while `blanked` is true.
export const Route = createFileRoute("/api/v1/kiosk/display")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = await authenticateKiosk(request);
        if ("error" in auth) {
          return kioskError(auth.error.code, auth.error.message, auth.error.status);
        }
        return kioskJson(await getKioskDisplay(auth.orgId));
      },
    },
  },
});
