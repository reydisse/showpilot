import handler from "@tanstack/react-start/server-entry";
import { getAuth } from "./lib/auth";
import { resolveEffectiveAccess } from "./lib/effective-access";
import type { Permission } from "./lib/permissions";
import { verifyCrewChatPass } from "./lib/crew-chat-pass";
import { chatRelayKey } from "./lib/chat-relay-key";
import { getTodayDateString } from "./lib/utils";
import { rundownRelayKey } from "./lib/rundown-relay-key";
import { handleMobileApi } from "./lib/mobile-api.server";
import { isAllowedApiOrigin } from "./lib/auth-origins";

// Durable Objects
export { ChatRelay } from "./durable-objects/ChatRelay";
export { RundownRelay } from "./durable-objects/RundownRelay";
export { LowerThirdsRelay } from "./durable-objects/LowerThirdsRelay";
export { TimecodeRelay } from "./durable-objects/TimecodeRelay";
export { BridgeRelay } from "./durable-objects/BridgeRelay";
export { CueSheetRelay } from "./durable-objects/CueSheetRelay";

interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  TIMECODE_RELAY: DurableObjectNamespace;
  BRIDGE_RELAY: DurableObjectNamespace<import("./durable-objects/BridgeRelay").BridgeRelay>;
  RUNDOWN_RELAY: DurableObjectNamespace;
  CHAT_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
  CUE_SHEET_RELAY: DurableObjectNamespace;
  KIOSK_SECRET?: string;
  EXPO_ACCESS_TOKEN?: string;
}

interface D1Result {
  success?: boolean;
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<D1Result>;
}

interface D1Database {
  prepare(sql: string): {
    bind(...params: unknown[]): D1PreparedStatement;
  };
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

function withApiCorsHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedApiOrigin(origin, request.url)) return response;

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

function withRuntimeCacheHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isDocument = contentType.includes("text/html");
  const isServerFunction = url.pathname.startsWith("/_serverFn/");

  if (!isDocument && !isServerFunction) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");

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
  // The desktop bridge connects through WebSocket and supplies its key in the
  // bridge connection URL (`?role=bridge&key=...`). Browser clients continue
  // to use the header, and query-string keys are only accepted for bridge
  // connections so they cannot accidentally authorize other API requests.
  const url = new URL(request.url);
  const presented =
    request.headers.get("x-showpilot-api-key") ??
    (url.searchParams.get("role") === "bridge" ? url.searchParams.get("key") : null);
  const expected = await getOrgApiKey(orgId, db);
  if (!presented || !expected) return false;

  const encoder = new TextEncoder();
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(presentedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

interface OrgIdentity {
  userId: string;
  name: string;
  role: string;
  permissions: Permission[];
}

async function getOrgIdentity(
  request: Request,
  orgId: string,
  db: Env["DB"],
): Promise<OrgIdentity | null> {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session) return null;
    const access = await resolveEffectiveAccess(db, session.user.id, orgId);
    if (!access) return null;
    return {
      userId: session.user.id,
      name: session.user.name,
      role: access.role,
      permissions: access.permissions,
    };
  } catch {
    return null;
  }
}

async function getRelayAccess(request: Request, orgId: string, db: Env["DB"]) {
  const [hasBridgeKey, identity] = await Promise.all([
    validateBridgeKey(request, orgId, db),
    getOrgIdentity(request, orgId, db),
  ]);
  return { hasBridgeKey, identity, canWrite: hasBridgeKey || Boolean(identity) };
}

function canUse(
  access: Awaited<ReturnType<typeof getRelayAccess>>,
  permissions: Permission | Permission[],
): boolean {
  if (access.hasBridgeKey) return true;
  if (!access.identity) return false;
  const required = Array.isArray(permissions) ? permissions : [permissions];
  return required.some((permission) => access.identity?.permissions.includes(permission));
}

async function canAccessChatRoom(
  roomId: string,
  access: Awaited<ReturnType<typeof getRelayAccess>>,
  orgId: string,
  db: Env["DB"],
  guest: boolean,
): Promise<boolean> {
  if (guest) return roomId === "production";
  if (roomId === "production" || roomId === "planning") return canUse(access, "chat:access");
  const parts = roomId.split(":");
  const isCanonicalDm = parts.length === 3 && parts[0] === "dm" && parts[1] < parts[2];
  if (!isCanonicalDm || !access.identity || !parts.slice(1).includes(access.identity.userId)) return false;
  const members = await Promise.all(parts.slice(1).map((userId) => db
    .prepare("SELECT userId FROM member WHERE organizationId = ? AND userId = ? LIMIT 1")
    .bind(orgId, userId)
    .first<{ userId: string }>()));
  return members.every(Boolean);
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

// Build-time commit SHA, injected by deploy.yml (VITE_COMMIT_SHA=${{ github.sha }}).
const COMMIT_SHA =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_COMMIT_SHA as string | undefined) ?? "dev";

export default {
  async fetch(request: Request, env: unknown, _ctx: unknown) {
    const url = new URL(request.url);
    const e = env as Env;

    // Unauthenticated health check for uptime monitors (UptimeRobot /
    // Better Stack — see DEPLOY.md). Must stay dependency-free: no DB,
    // no auth, so it reflects Worker liveness only.
    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok", commit: COMMIT_SHA }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const corsOrigin = request.headers.get("origin");
      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      };

      if (isAllowedApiOrigin(corsOrigin, request.url)) {
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

    const authMatch = url.pathname.match(/^\/api\/auth(?:\/.*)?$/);
    if (authMatch) {
      const auth = getAuth();
      return withApiCorsHeaders(request, await auth.handler(request));
    }

    const mobileResponse = await handleMobileApi(request, e);
    if (mobileResponse) return withApiCorsHeaders(request, mobileResponse);

    const tcMatch = url.pathname.match(/^\/api\/timecode\/([^/]+)\/(.+)$/);
    if (tcMatch) {
      const [, slugOrId, subpath] = tcMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      if (!canUse(access, "timecode:access")) return new Response("Unauthorized", { status: 401 });
      const id = e.TIMECODE_RELAY.idFromName(orgId);
      const stub = e.TIMECODE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      doUrl.searchParams.set("access", "write");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const bridgeMatch = url.pathname.match(/^\/api\/bridge\/([^/]+)\/(.+)$/);
    if (bridgeMatch) {
      const [, slugOrId, subpath] = bridgeMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      const requestedRole = url.searchParams.get("role") ?? "client";
      if (requestedRole === "bridge" ? !access.hasBridgeKey : !canUse(access, "devices:access")) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.BRIDGE_RELAY.idFromName(orgId);
      const stub = e.BRIDGE_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      doUrl.searchParams.set("access", "write");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const rundownMatch = url.pathname.match(/^\/api\/rundown\/([^/]+)\/(.+)$/);
    if (rundownMatch) {
      const [, slugOrId, subpath] = rundownMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      const canControl = canUse(access, "rundown:control");
      const canObserveRundown = canUse(access, [
        "rundown:view",
        "cuesheet:view",
        "cuesheet:edit",
        "cuesheet:add_notes",
      ]);
      const isMutation = subpath === "command" || (subpath === "ws" && canControl);
      if (subpath === "command" && !canControl) {
        return new Response("Unauthorized", { status: 401 });
      }
      const serviceDate = url.searchParams.get("serviceDate");
      const showId = url.searchParams.get("showId");
      const timezone = await e.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
        .bind(orgId).first<{ value: string }>();
      const id = e.RUNDOWN_RELAY.idFromName(
        rundownRelayKey(orgId, serviceDate, getTodayDateString(timezone?.value), showId),
      );
      const stub = e.RUNDOWN_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      doUrl.searchParams.set("access", isMutation ? "write" : canObserveRundown ? "observe" : "read");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Cue sheet fan-out. Same shape as the rundown relay above: the org
    // is resolved from the path, and the socket only carries edits that
    // have already been written to D1 by a permission-checked server
    // function — losing this connection costs live updates, never data.
    const cueMatch = url.pathname.match(/^\/api\/cue-sheet\/([^/]+)\/(.+)$/);
    if (cueMatch) {
      const [, slugOrId, subpath] = cueMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      if (!canUse(access, ["cuesheet:edit", "cuesheet:add_notes"])) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.CUE_SHEET_RELAY.idFromName(orgId);
      const stub = e.CUE_SHEET_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("access", "write");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    const chatFileMatch = url.pathname.match(/^\/api\/chat-file\/([^/]+)\/([^/]+)\/(.+)$/);
    if (chatFileMatch && request.method === "GET") {
      const [, slugOrId, fileId, encodedName] = chatFileMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      const guestToken = url.searchParams.get("guestToken");
      const guestPass = guestToken && e.KIOSK_SECRET ? await verifyCrewChatPass(guestToken, e.KIOSK_SECRET) : null;
      if (!canUse(access, "chat:access") && guestPass?.orgId !== orgId) {
        return new Response("Unauthorized", { status: 401 });
      }
      const fileName = decodeURIComponent(encodedName);
      const object = await e.STORAGE.get(`orgs/${orgId}/chat/${fileId}/${fileName}`);
      if (!object) return new Response("Not Found", { status: 404 });
      const objectRoom = object.customMetadata?.roomId ?? "production";
      if (!await canAccessChatRoom(objectRoom, access, orgId, e.DB, guestPass?.orgId === orgId)) {
        return new Response("Forbidden", { status: 403 });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, max-age=3600");
      headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      return new Response(object.body, { headers });
    }

    const chatMatch = url.pathname.match(/^\/api\/chat\/([^/]+)\/(.+)$/);
    if (chatMatch) {
      const [, slugOrId, subpath] = chatMatch;
      const orgId = await resolveOrgId(slugOrId, e.DB);
      const access = await getRelayAccess(request, orgId, e.DB);
      const guestToken = url.searchParams.get("guestToken");
      const guestPass = guestToken && e.KIOSK_SECRET ? await verifyCrewChatPass(guestToken, e.KIOSK_SECRET) : null;
      const guestAllowed = Boolean(guestPass && guestPass.orgId === orgId && (subpath === "ws" || subpath === "upload"));
      if (!canUse(access, "chat:access") && !guestAllowed) {
        return new Response("Unauthorized", { status: 401 });
      }
      const roomId = url.searchParams.get("room") ?? "production";
      if (!await canAccessChatRoom(roomId, access, orgId, e.DB, guestAllowed)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (access.identity?.userId) {
        await e.DB.prepare(
          `INSERT INTO chat_user_room (userId, orgId, roomId, updatedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(userId, orgId, roomId) DO UPDATE SET updatedAt = excluded.updatedAt`,
        ).bind(access.identity.userId, orgId, roomId, new Date().toISOString()).run();
      }
      if (subpath === "upload" && request.method === "POST") {
        const validGuest = Boolean(guestPass && guestPass.orgId === orgId);
        if (!canUse(access, "chat:access") && !validGuest) {
          return new Response("Unauthorized", { status: 401 });
        }
        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) return new Response("Choose a file to upload", { status: 400 });
        const allowedTypes = new Set([
          "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
          "application/pdf", "text/plain", "text/csv",
          "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ]);
        if (!allowedTypes.has(file.type)) return new Response("This file type is not supported", { status: 415 });
        if (file.size > 15 * 1024 * 1024) return new Response("Files must be 15 MB or smaller", { status: 413 });
        const fileId = crypto.randomUUID();
        const safeName = file.name.replace(/[\\/\u0000-\u001f]/g, "-").trim().slice(0, 180) || "attachment";
        await e.STORAGE.put(`orgs/${orgId}/chat/${fileId}/${safeName}`, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { uploadedBy: access.identity?.userId ?? "guest", roomId },
        });
        return Response.json({
          id: fileId,
          name: safeName,
          url: `/api/chat-file/${encodeURIComponent(orgId)}/${fileId}/${encodeURIComponent(safeName)}`,
          mimeType: file.type,
          size: file.size,
        });
      }
			const id = e.CHAT_RELAY.idFromName(chatRelayKey(orgId, roomId));
      const stub = e.CHAT_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("orgId", orgId);
      doUrl.searchParams.set("room", roomId);
      doUrl.searchParams.set("access", "write");
      if (guestAllowed) {
        doUrl.searchParams.set("name", (url.searchParams.get("guestName") || "Guest crew").trim().slice(0, 60));
        doUrl.searchParams.set("role", "Guest");
      } else if (access.identity) {
        doUrl.searchParams.set("userId", access.identity.userId);
        doUrl.searchParams.set("name", access.identity.name);
        doUrl.searchParams.set("role", access.identity.role);
      }
      if (subpath === "send" && request.method === "POST" && access.identity) {
        let body: Record<string, unknown>;
        try {
          body = await request.json<Record<string, unknown>>();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        body.orgId = orgId;
        body.senderId = access.identity.userId;
        body.senderName = access.identity.name;
        body.senderRole = access.identity.role;
        return stub.fetch(new Request(doUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }));
      }
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Avatar upload — POST /api/user/avatar
    if (url.pathname === "/api/user/avatar" && request.method === "POST") {
      const session = await getAuth().api.getSession({ headers: request.headers });
      if (!session?.user.id) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return Response.json({ error: "Invalid upload" }, { status: 400 });
      }
      const file = formData.get("file");
      if (!(file instanceof File) || file.type !== "image/jpeg" || file.size === 0) {
        return Response.json({ error: "Avatar must be a JPEG image" }, { status: 400 });
      }
      if (file.size > 2 * 1024 * 1024) {
        return Response.json({ error: "Avatar must be smaller than 2 MB" }, { status: 413 });
      }

      const arrayBuffer = await file.arrayBuffer();
      const key = `avatars/${session.user.id}.jpg`;
      await e.STORAGE.put(key, arrayBuffer, { httpMetadata: { contentType: "image/jpeg" } });
      const avatarPath = `/api/user/avatar/${session.user.id}.jpg?v=${Date.now()}`;
      return Response.json({ url: avatarPath });
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
      const access = await getRelayAccess(request, orgId, e.DB);
      const isMutation = subpath !== "current" && subpath !== "ws";
      const canControl = canUse(access, "lowerthird:trigger");
      if (isMutation && !canControl) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = e.LOWER_THIRDS_RELAY.idFromName(orgId);
      const stub = e.LOWER_THIRDS_RELAY.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/${subpath}`;
      doUrl.searchParams.set("access", canControl ? "write" : "read");
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // TanStack Start's handler reads env/ctx via `cloudflare:workers` itself;
    // its fetch only takes (request, options?).
    const response = await handler.fetch(request);
    return withRuntimeCacheHeaders(request, withApiCorsHeaders(request, response));
  },
  async scheduled(_controller: ScheduledController, e: Env): Promise<void> {
    const { checkExpoPushReceipts } = await import("./lib/expo-push-receipts.server");
    await checkExpoPushReceipts(e.DB, { accessToken: e.EXPO_ACCESS_TOKEN });
  },
};
