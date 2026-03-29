import handler from "@tanstack/react-start/server-entry";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";
export { TimecodeRelay } from "./durable-objects/TimecodeRelay";

interface Env {
  TIMECODE_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    // Handle CORS preflight for API routes
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Route Durable Object WebSocket/API requests
    // Pattern: /api/timecode/:orgId/ws or /api/timecode/:orgId/state etc.
    const tcMatch = url.pathname.match(/^\/api\/timecode\/([^/]+)\/(.+)$/);
    if (tcMatch) {
      const [, orgId, subpath] = tcMatch;
      const e = env as Env;
      const id = e.TIMECODE_RELAY.idFromName(orgId);
      const stub = e.TIMECODE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return handler.fetch(request, env, ctx);
  },
};
