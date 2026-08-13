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
  roomId?: string;
  replyTo?: { messageId: string; senderName: string; text: string };
  attachments?: Array<{ id: string; name: string; url: string; mimeType: string; size: number }>;
  editedAt?: number;
  deletedAt?: number;
}

interface ChatRelayEnv {}

export class ChatRelay extends DurableObject<ChatRelayEnv> {
  private sessions: Map<WebSocket, { userId?: string; name: string; role?: string; orgId: string; roomId: string }> = new Map();
  private recentMessages: ChatMessage[] = [];
  private readonly MAX_MESSAGES = 2000;
  private historyLoaded = false;
  private roomId = "production";

  constructor(ctx: DurableObjectState, env: ChatRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      )`);
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS chat_messages_timestamp_idx ON chat_messages(timestamp)");
    });
  }

  private async ensureHistoryLoaded() {
    if (this.historyLoaded) return;
    this.historyLoaded = true;

    const rows = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM chat_messages ORDER BY timestamp DESC LIMIT ?",
      this.MAX_MESSAGES,
    ).toArray().reverse();
    if (rows.length) {
      this.recentMessages = rows.flatMap((row) => {
        try { return [JSON.parse(row.payload) as ChatMessage]; } catch { return []; }
      });
      return;
    }

    // One-time compatibility migration from the original single-value store.
    const legacy = await this.ctx.storage.get<ChatMessage[]>("recentMessages");
    if (legacy?.length) {
      this.persistMessages(legacy.slice(-this.MAX_MESSAGES));
      this.recentMessages = legacy.slice(-this.MAX_MESSAGES);
      await this.ctx.storage.delete("recentMessages");
    }
  }

  private persistMessages(messages = this.recentMessages) {
    this.ctx.storage.sql.exec("DELETE FROM chat_messages");
    for (const message of messages) {
      this.ctx.storage.sql.exec(
        "INSERT INTO chat_messages (id, timestamp, payload) VALUES (?, ?, ?)",
        message.id,
        message.timestamp,
        JSON.stringify(message),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.ensureHistoryLoaded();

    if (url.pathname === "/ws") {
      this.roomId = url.searchParams.get("room") ?? "production";
      await this.pruneHistory();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.set(server, {
        userId: url.searchParams.get("userId") ?? undefined,
        name: url.searchParams.get("name") ?? "Gateway",
        role: url.searchParams.get("role") ?? undefined,
        orgId: url.searchParams.get("orgId") ?? "",
        roomId: this.roomId,
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

      await this.addMessage(message);
      this.broadcast(JSON.stringify({ type: "message", message }));

      return Response.json({ ok: true, message });
    }

    if (url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50");
      return Response.json(this.recentMessages.slice(-limit));
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const parsed = JSON.parse(data as string) as {
        type: string;
        name?: string;
        role?: string;
        text?: string;
        messageType?: ChatMessage["type"];
        senderId?: string;
        orgId?: string;
        replyTo?: ChatMessage["replyTo"];
        attachments?: ChatMessage["attachments"];
        messageId?: string;
      };

      if (parsed.type === "identify") {
        // Identity is established by the Worker gateway, never by a client frame.
        return;
      }

      if (parsed.type === "message") {
        const session = this.sessions.get(ws) ??
          (ws.deserializeAttachment?.() as { userId?: string; name: string; role?: string; orgId: string; roomId: string } | null);
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
          roomId: session.roomId,
          replyTo: this.cleanReply(parsed.replyTo),
          attachments: this.cleanAttachments(parsed.attachments, session.orgId),
        };

        if (!message.text && !message.attachments?.length) return;
        await this.addMessage(message);
        this.broadcast(JSON.stringify({ type: "message", message }));
        return;
      }

      if (parsed.type === "edit" || parsed.type === "delete") {
        const session = this.sessions.get(ws) ??
          (ws.deserializeAttachment?.() as { userId?: string; name: string; role?: string; orgId: string; roomId: string } | null);
        if (!session?.userId || !parsed.messageId) return;
        const index = this.recentMessages.findIndex((message) => message.id === parsed.messageId);
        const current = this.recentMessages[index];
        if (!current || current.senderId !== session.userId || current.deletedAt) return;
        const now = Date.now();
        const updated: ChatMessage = parsed.type === "delete"
          ? { ...current, text: "", attachments: undefined, deletedAt: now, editedAt: undefined }
          : { ...current, text: (parsed.text ?? "").trim().slice(0, 4000), editedAt: now };
        if (parsed.type === "edit" && !updated.text) return;
        const nextMessages = [...this.recentMessages];
        nextMessages[index] = updated;
        this.persistMessages(nextMessages);
        this.recentMessages = nextMessages;
        this.broadcast(JSON.stringify({ type: parsed.type === "delete" ? "message-deleted" : "message-edited", message: updated }));
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

  private async addMessage(message: ChatMessage) {
    const nextMessages = [...this.recentMessages, message].slice(-this.MAX_MESSAGES);
    this.persistMessages(nextMessages);
    this.recentMessages = nextMessages;
  }

  private async pruneHistory() {
    if (this.roomId !== "planning") return;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const retained = this.recentMessages.filter((message) => message.timestamp >= weekAgo);
    if (retained.length !== this.recentMessages.length) {
      this.persistMessages(retained);
      this.recentMessages = retained;
    }
  }

  private cleanReply(reply: ChatMessage["replyTo"]): ChatMessage["replyTo"] {
    if (!reply?.messageId) return undefined;
    const original = this.recentMessages.find((message) => message.id === String(reply.messageId));
    if (!original) return undefined;
    return {
      messageId: original.id,
      senderName: original.senderName.slice(0, 80),
      text: original.text.slice(0, 240),
    };
  }

  private cleanAttachments(attachments: ChatMessage["attachments"], orgId: string): ChatMessage["attachments"] {
    if (!Array.isArray(attachments)) return undefined;
    const requiredPrefix = `/api/chat-file/${encodeURIComponent(orgId)}/`;
    const clean = attachments.slice(0, 6).flatMap((attachment) => {
      if (!attachment?.id || !attachment.url?.startsWith(requiredPrefix) || !attachment.name) return [];
      return [{
        id: String(attachment.id).slice(0, 100),
        name: String(attachment.name).slice(0, 180),
        url: String(attachment.url).slice(0, 1000),
        mimeType: String(attachment.mimeType || "application/octet-stream").slice(0, 120),
        size: Math.max(0, Number(attachment.size) || 0),
      }];
    });
    return clean.length ? clean : undefined;
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
