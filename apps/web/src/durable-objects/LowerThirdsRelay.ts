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
  private current: LowerThirdPayload | null = null;
  private queue: LowerThirdPayload | null = null;
  private hydration: Promise<void> | null = null;

  private hydrateFromStorage(): Promise<void> {
    this.hydration ??= this.loadState();
    return this.hydration;
  }

  private async loadState(): Promise<void> {
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
      server.serializeAttachment?.({ canWrite: url.searchParams.get("access") === "write" });

      // Hydrate late connectors
      if (this.current) {
        server.send(
          JSON.stringify({ action: "show", payload: this.current })
        );
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      if (url.searchParams.get("access") === "read") return new Response("Unauthorized", { status: 401 });
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
      if (url.searchParams.get("access") === "read") return new Response("Unauthorized", { status: 401 });
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
      if (url.searchParams.get("access") === "read") return new Response("Unauthorized", { status: 401 });
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

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    await this.hydrateFromStorage();
    try {
      const attachment = ws.deserializeAttachment?.() as { canWrite?: boolean } | null;
      if (!attachment?.canWrite) return;
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

  webSocketClose() {}

  webSocketError() {}

  private broadcast(data: string) {
    // Cloudflare retains accepted sockets across Durable Object hibernation;
    // an instance Set would lose every connected display on wake.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        try { ws.close(1011, "Broadcast failed"); } catch {}
      }
    }
  }
}
