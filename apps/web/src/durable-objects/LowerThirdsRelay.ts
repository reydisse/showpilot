import { DurableObject } from "cloudflare:workers";

export type LowerThirdType = "person" | "scripture" | "freetext" | "style";
export type LowerThirdState = "idle" | "live" | "clearing";

export interface LowerThirdPayload {
  id: string;
  type: LowerThirdType;
  name?: string;
  title?: string;
  scripture?: string;
  translation?: string;
  line1?: string;
  line2?: string;
  style: string; // "default" | "minimal" | "scripture"
  state: LowerThirdState;
  triggeredBy?: string;
  triggeredAt?: number;
}

export class LowerThirdsRelay extends DurableObject {
  private sessions: Set<WebSocket> = new Set();
  private current: LowerThirdPayload | null = null;
  private queue: LowerThirdPayload | null = null;
  private hydrated = false;

  private async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;

    const stored = await this.ctx.storage.get<{
      current: LowerThirdPayload | null;
      queue: LowerThirdPayload | null;
    }>("state");

    if (stored) {
      this.current = stored.current ?? null;
      this.queue = stored.queue ?? null;
    }
  }

  private persistState(): Promise<void> {
    return this.ctx.storage.put("state", {
      current: this.current,
      queue: this.queue,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrateFromStorage();
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);

      // Hydrate late connectors
      if (this.current) {
        server.send(
          JSON.stringify({ action: "show", payload: this.current })
        );
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      const body = (await request.json()) as Partial<LowerThirdPayload>;
      const payload: LowerThirdPayload = {
        id: body.id ?? crypto.randomUUID(),
        type: body.type ?? "freetext",
        name: body.name,
        title: body.title,
        scripture: body.scripture,
        translation: body.translation,
        line1: body.line1,
        line2: body.line2,
        style: body.style ?? "default",
        state: "live",
        triggeredBy: body.triggeredBy,
        triggeredAt: Date.now(),
      };

      this.current = payload;
      await this.persistState();
      this.broadcast(JSON.stringify({ action: "show", payload }));
      return Response.json({ ok: true, payload });
    }

    if (url.pathname === "/clear" && request.method === "POST") {
      if (this.current) {
        this.current.state = "clearing";
        this.broadcast(
          JSON.stringify({ action: "clear", payload: this.current })
        );
        this.current = null;
        await this.persistState();
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/queue" && request.method === "POST") {
      const body = (await request.json()) as Partial<LowerThirdPayload>;
      this.queue = {
        id: body.id ?? crypto.randomUUID(),
        type: body.type ?? "freetext",
        name: body.name,
        title: body.title,
        scripture: body.scripture,
        translation: body.translation,
        line1: body.line1,
        line2: body.line2,
        style: body.style ?? "default",
        state: "idle",
        triggeredBy: body.triggeredBy,
      };
      await this.persistState();
      return Response.json({ ok: true, queued: this.queue });
    }

    if (url.pathname === "/current") {
      return Response.json({
        current: this.current,
        queue: this.queue,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    await this.hydrateFromStorage();
    try {
      const parsed = JSON.parse(data as string) as {
        action: string;
        payload?: Partial<LowerThirdPayload>;
      };

      if (parsed.action === "trigger" && parsed.payload) {
        const payload: LowerThirdPayload = {
          id: parsed.payload.id ?? crypto.randomUUID(),
          type: parsed.payload.type ?? "freetext",
          name: parsed.payload.name,
          title: parsed.payload.title,
          scripture: parsed.payload.scripture,
          translation: parsed.payload.translation,
          line1: parsed.payload.line1,
          line2: parsed.payload.line2,
          style: parsed.payload.style ?? "default",
          state: "live",
          triggeredBy: parsed.payload.triggeredBy,
          triggeredAt: Date.now(),
        };
        this.current = payload;
        await this.persistState();
        this.broadcast(JSON.stringify({ action: "show", payload }));
      }

      if (parsed.action === "clear") {
        if (this.current) {
          this.current.state = "clearing";
          this.broadcast(
            JSON.stringify({ action: "clear", payload: this.current })
          );
          this.current = null;
          await this.persistState();
        }
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  private broadcast(data: string) {
    for (const ws of this.sessions) {
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
