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
  RUNDOWN_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

interface D1Database {
  prepare(sql: string): { bind(...params: unknown[]): { first<T>(): Promise<T | null> } };
}

async function getOrgApiKey(orgId: string, db: Env["DB"]): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(orgId, "api-key")
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function validateBridgeKey(request: Request, orgId: string, db: Env["DB"]): Promise<boolean> {
  const presented = request.headers.get("x-showpilot-api-key");
  if (!presented) return true;

  const expected = await getOrgApiKey(orgId, db);
  if (!expected) return true;

  return presented === expected;
}

async function resolveOrgId(slugOrId: string, db: Env["DB"]): Promise<string> {
  const byId = await db
    .prepare("SELECT id FROM organization WHERE id = ?")
    .bind(slugOrId)
    .first<{ id: string }>();
  if (byId) return byId.id;

  const bySlug = await db
    .prepare("SELECT id FROM organization WHERE slug = ?")
    .bind(slugOrId)
    .first<{ id: string }>();
  if (bySlug) return bySlug.id;

  return slugOrId;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);
    const e = env as Env;

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

    const bridgeMatch = url.pathname.match(/^\/api\/bridge\/([^/]+)\/(.+)$/);
    if (bridgeMatch) {
      const [, slugOrId, subpath] = bridgeMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const id = e.BRIDGE_RELAY.idFromName(orgId);
      const stub = e.BRIDGE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const rundownMatch = url.pathname.match(/^\/api\/rundown\/([^/]+)\/(.+)$/);
    if (rundownMatch) {
      const [, slugOrId, subpath] = rundownMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      if (!(await validateBridgeKey(request, orgId, e.DB))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.RUNDOWN_RELAY.idFromName(orgId);
      const stub = e.RUNDOWN_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const chatMatch = url.pathname.match(/^\/api\/chat\/([^/]+)\/(.+)$/);
    if (chatMatch) {
      const [, slugOrId, subpath] = chatMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      if (!(await validateBridgeKey(request, orgId, e.DB))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.CHAT_RELAY.idFromName(orgId);
      const stub = e.CHAT_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const ltMatch = url.pathname.match(/^\/api\/lowerthirds\/([^/]+)\/(.+)$/);
    if (ltMatch) {
      const [, slugOrId, subpath] = ltMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      if (!(await validateBridgeKey(request, orgId, e.DB))) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.LOWER_THIRDS_RELAY.idFromName(orgId);
      const stub = e.LOWER_THIRDS_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return handler.fetch(request, env, ctx);
  },
};
