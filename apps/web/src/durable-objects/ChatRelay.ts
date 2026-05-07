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
  private sessions: Map<WebSocket, { name: string; role?: string }> = new Map();
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
      this.sessions.set(server, { name: "Anonymous" });

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
      const body = (await request.json()) as Partial<ChatMessage>;
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        orgId: body.orgId ?? "",
        senderId: body.senderId,
        senderName: body.senderName ?? "Unknown",
        senderRole: body.senderRole,
        text: body.text ?? "",
        type: body.type ?? "text",
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
        this.sessions.set(ws, {
          name: parsed.name ?? "Anonymous",
          role: parsed.role,
        });
        return;
      }

      if (parsed.type === "message") {
        const session = this.sessions.get(ws);
        const nextName = parsed.name?.trim() || session?.name || "Anonymous";
        const nextRole = parsed.role ?? session?.role;

        this.sessions.set(ws, {
          name: nextName,
          role: nextRole,
        });

        const message: ChatMessage = {
          id: crypto.randomUUID(),
          orgId: parsed.orgId ?? "",
          senderId: parsed.senderId,
          senderName: nextName,
          senderRole: nextRole,
          text: parsed.text ?? "",
          type: parsed.messageType ?? "text",
          timestamp: Date.now(),
        };

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
