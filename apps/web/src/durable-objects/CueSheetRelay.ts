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
 * Nothing is written to DO storage for the same reason. There is no state
 * here worth surviving an eviction that isn't already in D1.
 */

import { DurableObject } from "cloudflare:workers";

/** A cell changed. Scoped by service date so other dates ignore it. */
export interface CueNoteEvent {
  type: "note";
  serviceDate: string;
  itemId: string;
  columnId: string;
  text: string;
  /** Who typed it, for the "editing" hint. Empty when unknown. */
  by: string;
  at: number;
}

/**
 * Columns changed shape — added, renamed, recoloured, resized, reordered
 * or deleted. The payload is deliberately not a diff: column edits are
 * rare and a "reload your columns" nudge is far harder to get wrong than
 * replaying a structural patch.
 */
export interface CueColumnsEvent {
  type: "columns";
  at: number;
}

/** An incident changed in D1; subscribers reload their scoped view. */
export interface IncidentEvent {
  type: "incident";
  incidentId: string;
  action: "created" | "updated" | "assigned" | "acknowledged" | "resolved" | "deleted" | "commented";
  at: number;
}

export type CueSheetEvent = CueNoteEvent | CueColumnsEvent | IncidentEvent;

export class CueSheetRelay extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({ canWrite: url.searchParams.get("access") === "write" });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      if (url.searchParams.get("access") === "read") {
        return new Response("Unauthorized", { status: 401 });
      }
      const event = (await request.json()) as CueSheetEvent;
      this.broadcast(JSON.stringify(event));
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
      const attachment = sender.deserializeAttachment?.() as { canWrite?: boolean } | null;
      if (!attachment?.canWrite) return;
      const parsed = JSON.parse(data as string) as CueSheetEvent;
      if (parsed.type !== "note" && parsed.type !== "columns" && parsed.type !== "incident") return;
      // Don't echo to the sender: it already applied the change locally,
      // and bouncing it back would fight their cursor mid-word.
      this.broadcast(data as string, sender);
    } catch {
      // A malformed frame is not worth dropping the connection over.
    }
  }

  webSocketClose() {}

  webSocketError() {}

  private broadcast(data: string, except?: WebSocket) {
    // getWebSockets survives Durable Object hibernation; an in-memory Set
    // does not and silently loses every subscriber after the object wakes.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        try { ws.close(1011, "Broadcast failed"); } catch {}
      }
    }
  }
}
