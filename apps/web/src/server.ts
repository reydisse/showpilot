import handler from "@tanstack/react-start/server-entry";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";

interface Env {
  DB: { prepare(sql: string): { bind(...params: unknown[]): { first<T>(): Promise<T | null> } } };
  RUNDOWN_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

async function resolveOrgId(slugOrId: string, db: Env["DB"]): Promise<string> {
  if (slugOrId.includes("-") || /^[a-z]/.test(slugOrId)) {
    const row = await db
      .prepare("SELECT id FROM organization WHERE slug = ?")
      .bind(slugOrId)
      .first<{ id: string }>();
    if (row) return row.id;
  }
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

    // Route RundownRelay: /api/rundown/:orgSlugOrId/ws|state|command
    const rundownMatch = url.pathname.match(/^\/api\/rundown\/([^/]+)\/(.+)$/);
    if (rundownMatch) {
      const [, slugOrId, subpath] = rundownMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.RUNDOWN_RELAY.idFromName(orgId);
      const stub = e.RUNDOWN_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Route ChatRelay: /api/chat/:orgSlugOrId/ws|send|history
    const chatMatch = url.pathname.match(/^\/api\/chat\/([^/]+)\/(.+)$/);
    if (chatMatch) {
      const [, slugOrId, subpath] = chatMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.CHAT_RELAY.idFromName(orgId);
      const stub = e.CHAT_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Route LowerThirdsRelay: /api/lowerthirds/:orgSlugOrId/ws|trigger|clear|queue|current
    const ltMatch = url.pathname.match(/^\/api\/lowerthirds\/([^/]+)\/(.+)$/);
    if (ltMatch) {
      const [, slugOrId, subpath] = ltMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.LOWER_THIRDS_RELAY.idFromName(orgId);
      const stub = e.LOWER_THIRDS_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return handler.fetch(request, env, ctx);
  },
};
