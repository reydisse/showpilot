/**
 * CueSheetRelay — one room per org, so operators editing the same cue
 * sheet see each other's notes appear.
 *
 * The relay is deliberately not the source of truth. Cells are written to
 * D1 by the server function; this object only fans the change out to the
 * other tabs. If the relay is unreachable the edit still persists and the
 * others pick it up on their next load — a broken socket must never cost
 * an operator a note they typed during a service.
 *
 * Only a message revision is stored here; the authoritative cells stay in D1.
 * A reconnect compares revisions and reloads the caller's scoped D1 view.
 */

import { DurableObject } from "cloudflare:workers";
import { renewSocketReadLease, socketReadLeaseAllows, refreshSocketReadLeases, scheduleSocketReadRefresh, socketAuthorityClaim } from "@/lib/socket-read-authority.server";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
} from "@/lib/live-rundown-authority.server";

import { cueSheetEventSchema, type CueSheetEvent } from "@/lib/cue-sheet-events";
import { RelaySequenceStore } from "@/lib/relay-sequence.server";

type CueRelayScope = "columns" | "notes" | "incidents";

export class CueSheetRelay extends DurableObject<Pick<Env, "DB"> & { BETTER_AUTH_SECRET?: string }> {
  private readonly revisions = new RelaySequenceStore(this.ctx.storage.sql);

  private hydrate(socket: WebSocket): void {
    if (!socketReadLeaseAllows(socket, socketAuthorityClaim(socket) !== null)) return;
    socket.send(JSON.stringify({ type: "hydrate", ...this.revisions.envelope(socket) }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      const authClaim = this.readAuthorityClaim(url);
      if (authClaim && !(await this.canRead(authClaim))) return new Response("Unauthorized", { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        scopes: authClaim ? this.readScopes(url) : [],
        authClaim,
      });
      if (authClaim) renewSocketReadLease(server);
      await scheduleSocketReadRefresh(this.ctx, socket => socketAuthorityClaim(socket) !== null);
      this.hydrate(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const parsed = cueSheetEventSchema.safeParse(await request.json());
      if (!parsed.success) return new Response("Invalid cue-sheet event", { status: 400 });
      const event = parsed.data;
      if (!(await this.canPublish(this.readAuthorityClaim(url), this.readScopes(url), event))) {
        return new Response("Unauthorized", { status: 401 });
      }
      this.broadcast(event);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Clients may also publish directly over the socket. Same payload, one
   * less round trip — used for the optimistic path where the writer has
   * already called the server function.
   */
  async webSocketMessage(sender: WebSocket, data: string | ArrayBuffer) {
    try {
      const attachment = sender.deserializeAttachment?.() as {
        scopes?: CueRelayScope[];
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      const message: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (message && typeof message === "object" && "type" in message) {
        if (message.type === "sync") { this.hydrate(sender); return; }
        // Old clients sent a keepalive. It carries no data or write authority.
        if (message.type === "ping") {
          if (socketReadLeaseAllows(sender, socketAuthorityClaim(sender) !== null)) sender.send(JSON.stringify({ type: "pong" }));
          return;
        }
      }
      const result = cueSheetEventSchema.safeParse(message);
      if (!result.success) return;
      const parsed = result.data;
      if (!(await this.canPublish(attachment?.authClaim ?? null, attachment?.scopes ?? [], parsed))) {
        sender.close(4403, "Cue sheet access changed");
        return;
      }
      if (parsed.type !== "note" && parsed.type !== "columns" && parsed.type !== "incident") return;
      renewSocketReadLease(sender);
      // Don't echo to the sender: it already applied the change locally,
      // and bouncing it back would fight their cursor mid-word.
      this.broadcast(parsed, sender);
    } catch {
      // A malformed frame is not worth dropping the connection over.
    }
  }

  webSocketClose() {}

  webSocketError() {}

  private readAuthorityClaim(url: URL): LiveSessionAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    const orgId = url.searchParams.get("orgId")?.trim();
    return userId && sessionId && orgId ? { userId, sessionId, orgId } : null;
  }

  private readScopes(url: URL): CueRelayScope[] {
    const values = new Set(url.searchParams.get("access")?.split(",") ?? []);
    return (["columns", "notes", "incidents"] as const).filter((scope) => values.has(scope));
  }

  private scopeAllows(scopes: readonly CueRelayScope[], event: CueSheetEvent): boolean {
    if (event.type === "columns") return scopes.includes("columns");
    if (event.type === "note") return scopes.includes("notes");
    if (event.type === "incident") return scopes.includes("incidents");
    return false;
  }

  private async canPublish(claim: LiveSessionAuthorityClaim | null, scopes: readonly CueRelayScope[], event: CueSheetEvent): Promise<boolean> {
    if (!claim || !this.scopeAllows(scopes, event)) return false;
    return hasLivePermissionAuthority(this.env.DB, claim, event.type === "columns"
      ? "cuesheet:edit"
      : event.type === "note"
        ? ["cuesheet:edit", "cuesheet:add_notes"]
        : ["incidents:report", "incidents:access"]);
  }

  private broadcast(data: CueSheetEvent, except?: WebSocket) {
    const sequence = this.revisions.next();
    // getWebSockets survives Durable Object hibernation; an in-memory Set
    // does not and silently loses every subscriber after the object wakes.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      if (!socketReadLeaseAllows(ws, socketAuthorityClaim(ws) !== null)) continue;
      try {
        ws.send(JSON.stringify({ ...data, ...this.revisions.envelope(ws, sequence) }));
      } catch {
        try { ws.close(1011, "Broadcast failed"); } catch {}
      }
    }
  }

  private canRead(claim: LiveSessionAuthorityClaim): Promise<boolean> {
    return hasLivePermissionAuthority(this.env.DB, claim, ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes", "incidents:report", "incidents:access"]);
  }

  async refreshReadAuthority(userId?: string): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const claim = socketAuthorityClaim(socket);
      if (!claim || (userId && claim.userId !== userId)) return null;
      return this.canRead(claim);
    });
    await scheduleSocketReadRefresh(this.ctx, socket => socketAuthorityClaim(socket) !== null);
  }

  async alarm(): Promise<void> { await this.refreshReadAuthority(); }
}
