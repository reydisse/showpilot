import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";

function getSessionEndpointRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/auth/get-session";
  return new Request(url.toString(), request);
}

export const Route = createFileRoute("/api/auth/session")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const auth = getAuth();
        return await auth.handler(getSessionEndpointRequest(request));
      },
      POST: async ({ request }: { request: Request }) => {
        const auth = getAuth();
        return await auth.handler(getSessionEndpointRequest(request));
      },
    },
  },
});
