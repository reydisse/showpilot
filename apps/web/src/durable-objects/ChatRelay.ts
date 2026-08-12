import { DurableObject } from "cloudflare:workers";

interface ChatMessage {
  id: string;
  orgId: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: "text" | "alert" | "cue" | "system";
  timestamp: number;
}

export class ChatRelay extends DurableObject {
  private sessions: Map<WebSocket, { userId?: string; name: string; role?: string; orgId: string }> = new Map();
  private recentMessages: ChatMessage[] = [];
  private readonly MAX_MESSAGES = 200;
  private historyLoaded = false;

  private async ensureHistoryLoaded() {
    if (this.historyLoaded) return;
    this.historyLoaded = true;

    const stored = await this.ctx.storage.get<ChatMessage[]>("recentMessages");
    if (stored?.length) {
      this.recentMessages = stored;
    }
  }

  private persistMessages() {
    this.ctx.storage.put("recentMessages", this.recentMessages);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.ensureHistoryLoaded();

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.set(server, {
        userId: url.searchParams.get("userId") ?? undefined,
        name: url.searchParams.get("name") ?? "Gateway",
        role: url.searchParams.get("role") ?? undefined,
        orgId: url.searchParams.get("orgId") ?? "",
      });
      server.serializeAttachment?.(this.sessions.get(server));

      // Send recent messages for hydration
      server.send(
        JSON.stringify({
          type: "hydrate",
          messages: this.recentMessages,
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/send" && request.method === "POST") {
      if (url.searchParams.get("access") === "read") {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = (await request.json()) as Partial<ChatMessage>;
      const text = (body.text ?? "").trim().slice(0, 4000);
      if (!text) return new Response("Bad Request", { status: 400 });
      const messageType = body.type === "alert" || body.type === "cue" || body.type === "system"
        ? body.type
        : "text";
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        orgId: body.orgId ?? "",
        senderId: body.senderId,
        senderName: body.senderName ?? "Unknown",
        senderRole: body.senderRole,
        text,
        type: messageType,
        timestamp: Date.now(),
      };

      this.addMessage(message);
      this.broadcast(JSON.stringify({ type: "message", message }));

      return Response.json({ ok: true, message });
    }

    if (url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50");
      return Response.json(this.recentMessages.slice(-limit));
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const parsed = JSON.parse(data as string) as {
        type: string;
        name?: string;
        role?: string;
        text?: string;
        messageType?: ChatMessage["type"];
        senderId?: string;
        orgId?: string;
      };

      if (parsed.type === "identify") {
        // Identity is established by the Worker gateway, never by a client frame.
        return;
      }

      if (parsed.type === "message") {
        const session = this.sessions.get(ws) ??
          (ws.deserializeAttachment?.() as { userId?: string; name: string; role?: string; orgId: string } | null);
        if (!session) return;
        this.sessions.set(ws, session);

        const message: ChatMessage = {
          id: crypto.randomUUID(),
          orgId: session.orgId,
          senderId: session.userId,
          senderName: session.name,
          senderRole: session.role,
          text: (parsed.text ?? "").trim().slice(0, 4000),
          type: parsed.messageType === "alert" || parsed.messageType === "cue"
            ? parsed.messageType
            : "text",
          timestamp: Date.now(),
        };

        if (!message.text) return;
        this.addMessage(message);
        this.broadcast(JSON.stringify({ type: "message", message }));
      }
    } catch {
      // Ignore malformed messages
    }
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  private addMessage(message: ChatMessage) {
    this.recentMessages.push(message);
    if (this.recentMessages.length > this.MAX_MESSAGES) {
      this.recentMessages = this.recentMessages.slice(-this.MAX_MESSAGES);
    }
    this.persistMessages();
  }

  private broadcast(data: string, exclude?: WebSocket) {
    for (const [ws] of this.sessions) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
