import handler from "@tanstack/react-start/server-entry";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";
export { TimecodeRelay } from "./durable-objects/TimecodeRelay";
export { BridgeRelay } from "./durable-objects/BridgeRelay";

interface Env {
  DB: D1Database;
  TIMECODE_RELAY: DurableObjectNamespace;
  BRIDGE_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

interface D1Database {
  prepare(sql: string): { bind(...params: unknown[]): { first<T>(): Promise<T | null> } };
}

/** Resolve slug or orgId to orgId. Slugs contain hyphens/letters, IDs are alphanumeric. */
async function resolveOrgId(slugOrId: string, db: D1Database): Promise<string> {
  // If it looks like a slug (contains hyphens or starts with lowercase letter), look it up
  if (slugOrId.includes("-") || /^[a-z]/.test(slugOrId)) {
    const row = await db
      .prepare("SELECT id FROM organization WHERE slug = ?")
      .bind(slugOrId)
      .first<{ id: string }>();
    if (row) return row.id;
  }
  // Otherwise treat as raw org ID
  return slugOrId;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);
    const e = env as Env;

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
    // Accepts slug or orgId: /api/timecode/faithfire-production/ws
    const tcMatch = url.pathname.match(/^\/api\/timecode\/([^/]+)\/(.+)$/);
    if (tcMatch) {
      const [, slugOrId, subpath] = tcMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.TIMECODE_RELAY.idFromName(orgId);
      const stub = e.TIMECODE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Route Bridge WebSocket/API requests
    const bridgeMatch = url.pathname.match(/^\/api\/bridge\/([^/]+)\/(.+)$/);
    if (bridgeMatch) {
      const [, slugOrId, subpath] = bridgeMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.BRIDGE_RELAY.idFromName(orgId);
      const stub = e.BRIDGE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return handler.fetch(request, env, ctx);
  },
};
