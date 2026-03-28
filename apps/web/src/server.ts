import handler from "@tanstack/react-start/server-entry";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";
export { TimecodeRelay } from "./durable-objects/TimecodeRelay";

export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    // Handle CORS preflight for API routes
    if (request.method === "OPTIONS") {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
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
    }
    return handler.fetch(request, env, ctx);
  },
};
