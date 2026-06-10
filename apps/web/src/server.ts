import handler from "@tanstack/react-start/server-entry";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";
export { TimecodeRelay } from "./durable-objects/TimecodeRelay";
export { BridgeRelay } from "./durable-objects/BridgeRelay";

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  TIMECODE_RELAY: DurableObjectNamespace;
  BRIDGE_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

interface D1Database {
  prepare(sql: string): { bind(...params: unknown[]): { first<T>(): Promise<T | null> } };
}

function isAllowedApiOrigin(origin: string | null): boolean {
  if (!origin) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "showpilot.tech" ||
    host === "admin.showpilot.tech" ||
    host === "showpilot.reydisse.workers.dev" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) {
    return true;
  }

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "192.168.2.73" ||
    host === "192.168.2.108"
  ) {
    return true;
  }

  if (host.endsWith(".showpilot.tech")) return true;

  return false;
}

function withApiCorsHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedApiOrigin(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  async fetch(request: Request, env: unknown, _ctx: unknown) {
    const url = new URL(request.url);
    const e = env as Env;

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const corsOrigin = request.headers.get("origin");
      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      };

      if (isAllowedApiOrigin(corsOrigin)) {
        corsHeaders["Access-Control-Allow-Origin"] = corsOrigin!;
        corsHeaders["Access-Control-Allow-Credentials"] = "true";
        corsHeaders["Vary"] = "Origin";
      } else {
        corsHeaders["Access-Control-Allow-Origin"] = "*";
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders,
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
      doUrl.searchParams.set("orgId", orgId);
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

    // Avatar upload — POST /api/user/avatar
    if (url.pathname === "/api/user/avatar" && request.method === "POST") {
      const cookie = request.headers.get("cookie") ?? "";
      const tokenMatch = cookie.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
      const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
      const sessionRow = token
        ? await e.DB.prepare("SELECT userId FROM session WHERE token = ? AND expiresAt > datetime('now') LIMIT 1")
            .bind(token)
            .first<{ userId: string }>()
        : null;
      if (!sessionRow?.userId) return new Response("Unauthorized", { status: 401 });
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) return new Response("Bad Request", { status: 400 });
      const arrayBuffer = await file.arrayBuffer();
      const key = `avatars/${sessionRow.userId}.jpg`;
      await e.STORAGE.put(key, arrayBuffer, { httpMetadata: { contentType: "image/jpeg" } });
      const avatarUrl = `${url.origin}/api/user/avatar/${sessionRow.userId}.jpg`;
      return new Response(JSON.stringify({ url: avatarUrl }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Avatar serve — GET /api/user/avatar/:userId.jpg
    const avatarServeMatch = url.pathname.match(/^\/api\/user\/avatar\/([^/]+\.jpg)$/);
    if (avatarServeMatch && request.method === "GET") {
      const obj = await e.STORAGE.get(`avatars/${avatarServeMatch[1]}`);
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000",
        },
      });
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

    // TanStack Start's handler reads env/ctx via `cloudflare:workers` itself;
    // its fetch only takes (request, options?).
    const response = await handler.fetch(request);
    return withApiCorsHeaders(request, response);
  },
};
