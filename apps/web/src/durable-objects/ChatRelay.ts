import { DurableObject } from "cloudflare:workers";
import { scrubDeletedUserFromChat } from "@/lib/chat-account-deletion";
import { objectionableContentReason } from "@/lib/user-content-safety";
import {
  externalChatPollInterval,
  fetchExternalChatHistory,
  loadExternalChatConfiguration,
  sendExternalChatMessage,
  updateExternalChatMessage,
  type ExternalChatMessage,
  type ExternalChatPlatform,
} from "@/lib/external-chat-gateway";

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
  threadRootId?: string;
  replyTo?: { messageId: string; senderName: string; text: string };
  attachments?: Array<{ id: string; name: string; url: string; mimeType: string; size: number }>;
  poll?: { question: string; options: Array<{ id: string; text: string; voterIds: string[] }> };
  reactions?: Array<{ emoji: string; userIds: string[] }>;
  editedAt?: number;
  deletedAt?: number;
  external?: { platform: ExternalChatPlatform; id: string };
  externalDelivery?: {
    platform: ExternalChatPlatform;
    status: "pending" | "sent" | "failed";
    error?: string;
  };
}

type ChatRelayEnv = Pick<Env, "DB" | "STORAGE"> & {
  BETTER_AUTH_SECRET?: string;
};

interface GatewayStatusFrame {
  type: "gateway-status";
  platform: ExternalChatPlatform | null;
  status: "disabled" | "connecting" | "connected" | "error";
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExternalImport(value: unknown): { platform: ExternalChatPlatform; message: ExternalChatMessage } | null {
  if (!isRecord(value) || (value.platform !== "mattermost" && value.platform !== "slack" && value.platform !== "discord")) return null;
  if (!isRecord(value.message)
    || typeof value.message.externalId !== "string"
    || typeof value.message.senderName !== "string"
    || typeof value.message.text !== "string"
    || typeof value.message.timestamp !== "number"
    || !Number.isFinite(value.message.timestamp)) return null;
  const type = value.message.type === "alert" || value.message.type === "cue" ? value.message.type : "text";
  return {
    platform: value.platform,
    message: {
      externalId: value.message.externalId.slice(0, 128),
      senderId: typeof value.message.senderId === "string" ? value.message.senderId.slice(0, 200) : undefined,
      senderName: value.message.senderName.slice(0, 200) || `${value.platform} member`,
      text: value.message.text.slice(0, 4_000),
      type,
      timestamp: value.message.timestamp,
      replyToExternalId: typeof value.message.replyToExternalId === "string" ? value.message.replyToExternalId.slice(0, 128) : undefined,
      sourceNativeId: typeof value.message.sourceNativeId === "string" ? value.message.sourceNativeId.slice(0, 128) : undefined,
      editedAt: typeof value.message.editedAt === "number" && Number.isFinite(value.message.editedAt) ? value.message.editedAt : undefined,
      deletedAt: typeof value.message.deletedAt === "number" && Number.isFinite(value.message.deletedAt) ? value.message.deletedAt : undefined,
    },
  };
}

export class ChatRelay extends DurableObject<ChatRelayEnv> {
  private sessions: Map<WebSocket, { userId?: string; name: string; role?: string; orgId: string; roomId: string }> = new Map();
  private recentMessages: ChatMessage[] = [];
  /** Keep connection hydration bounded without treating that window as retention. */
  private readonly HYDRATION_MESSAGE_LIMIT = 2000;
  private historyLoad: Promise<void> | null = null;
  private roomId = "production";
  private orgId = "";
  private gatewayOperations: Promise<void> = Promise.resolve();
  private lastGatewayStatus: GatewayStatusFrame | null = null;

  constructor(ctx: DurableObjectState, env: ChatRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      )`);
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS chat_messages_timestamp_idx ON chat_messages(timestamp)");
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS chat_messages_timestamp_id_idx ON chat_messages(timestamp, id)");
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_reads (
        user_id TEXT PRIMARY KEY,
        read_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_context (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        org_id TEXT NOT NULL,
        room_id TEXT NOT NULL
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS external_chat_links (
        platform TEXT NOT NULL,
        external_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        PRIMARY KEY (platform, external_id),
        UNIQUE (platform, native_id)
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS external_chat_sync (
        platform TEXT PRIMARY KEY,
        cursor TEXT,
        synced_at INTEGER NOT NULL
      )`);
      const context = ctx.storage.sql.exec<{ org_id: string; room_id: string }>(
        "SELECT org_id, room_id FROM chat_context WHERE singleton = 1",
      ).toArray()[0];
      if (context) {
        this.orgId = context.org_id;
        this.roomId = context.room_id;
      }
    });
  }

  private ensureHistoryLoaded(): Promise<void> {
    this.historyLoad ??= this.loadHistory();
    return this.historyLoad;
  }

  private async loadHistory(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT ?",
      this.HYDRATION_MESSAGE_LIMIT,
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
      for (const message of legacy) this.persistMessage(message);
      this.recentMessages = legacy.slice(-this.HYDRATION_MESSAGE_LIMIT);
      await this.ctx.storage.delete("recentMessages");
    }
  }

  private persistMessage(message: ChatMessage) {
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_messages (id, timestamp, payload) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, payload = excluded.payload`,
      message.id,
      message.timestamp,
      JSON.stringify(message),
    );
  }

  private setContext(orgId: string, roomId: string): boolean {
    if (!orgId || !roomId) return false;
    if (this.orgId && (this.orgId !== orgId || this.roomId !== roomId)) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_context (singleton, org_id, room_id) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET org_id = excluded.org_id, room_id = excluded.room_id`,
      orgId,
      roomId,
    );
    this.orgId = orgId;
    this.roomId = roomId;
    return true;
  }

  private enqueueGatewayOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.gatewayOperations.catch(() => undefined).then(operation);
    this.gatewayOperations = next.catch((error) => {
      console.error(JSON.stringify({
        message: "external chat gateway operation failed",
        orgId: this.orgId,
        roomId: this.roomId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    return next;
  }

  private findMessage(messageId: string): ChatMessage | null {
    const recent = this.recentMessages.find((message) => message.id === messageId);
    if (recent) return recent;
    const row = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM chat_messages WHERE id = ? LIMIT 1",
      messageId,
    ).toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as ChatMessage;
    } catch {
      return null;
    }
  }

  private storeUpdatedMessage(message: ChatMessage) {
    this.persistMessage(message);
    const index = this.recentMessages.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) return;
    const messages = [...this.recentMessages];
    messages[index] = message;
    this.recentMessages = messages;
  }

  private externalIdForNative(platform: ExternalChatPlatform, nativeId: string): string | null {
    return this.ctx.storage.sql.exec<{ external_id: string }>(
      "SELECT external_id FROM external_chat_links WHERE platform = ? AND native_id = ? LIMIT 1",
      platform,
      nativeId,
    ).toArray()[0]?.external_id ?? null;
  }

  private nativeIdForExternal(platform: ExternalChatPlatform, externalId: string): string | null {
    return this.ctx.storage.sql.exec<{ native_id: string }>(
      "SELECT native_id FROM external_chat_links WHERE platform = ? AND external_id = ? LIMIT 1",
      platform,
      externalId,
    ).toArray()[0]?.native_id ?? null;
  }

  private linkExternalMessage(platform: ExternalChatPlatform, externalId: string, nativeId: string) {
    this.ctx.storage.sql.exec(
      `INSERT INTO external_chat_links (platform, external_id, native_id) VALUES (?, ?, ?)
       ON CONFLICT(platform, external_id) DO UPDATE SET native_id = excluded.native_id`,
      platform,
      externalId,
      nativeId,
    );
  }

  private updateExternalDelivery(
    messageId: string,
    delivery: NonNullable<ChatMessage["externalDelivery"]>,
  ) {
    const current = this.findMessage(messageId);
    if (!current) return;
    const updated = { ...current, externalDelivery: delivery };
    this.storeUpdatedMessage(updated);
    this.broadcast(JSON.stringify({ type: "message-edited", message: updated }));
  }

  private async forwardExternalMessage(message: ChatMessage): Promise<void> {
    if (this.roomId !== "production" || !this.orgId || message.external) return;
    const config = await loadExternalChatConfiguration(this.env.DB, this.orgId);
    if (!config) return;
    this.updateExternalDelivery(message.id, { platform: config.platform, status: "pending" });
    const rootNativeId = message.threadRootId ?? message.replyTo?.messageId;
    const externalRootId = rootNativeId
      ? this.externalIdForNative(config.platform, rootNativeId)
      : undefined;
    try {
      const result = await sendExternalChatMessage(config, message, externalRootId ?? undefined);
      if (result.externalId) this.linkExternalMessage(config.platform, result.externalId, message.id);
      this.updateExternalDelivery(message.id, { platform: config.platform, status: "sent" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "External delivery failed";
      this.updateExternalDelivery(message.id, {
        platform: config.platform,
        status: "failed",
        error: detail.slice(0, 240),
      });
      throw error;
    }
  }

  private async forwardExternalMutation(message: ChatMessage, deleted: boolean): Promise<void> {
    if (this.roomId !== "production" || !this.orgId || message.external) return;
    const config = await loadExternalChatConfiguration(this.env.DB, this.orgId);
    if (!config || config.platform === "teams") return;
    const externalId = this.externalIdForNative(config.platform, message.id);
    if (!externalId) return;
    this.updateExternalDelivery(message.id, { platform: config.platform, status: "pending" });
    try {
      await updateExternalChatMessage(config, externalId, deleted ? null : message);
      this.updateExternalDelivery(message.id, { platform: config.platform, status: "sent" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "External update failed";
      this.updateExternalDelivery(message.id, {
        platform: config.platform,
        status: "failed",
        error: detail.slice(0, 240),
      });
      throw error;
    }
  }

  private importExternalMessage(platform: ExternalChatPlatform, external: ExternalChatMessage) {
    const linkedNativeId = this.nativeIdForExternal(platform, external.externalId);
    if (linkedNativeId) {
      const current = this.findMessage(linkedNativeId);
      if (!current?.external || current.external.platform !== platform) return;
      const updated: ChatMessage = external.deletedAt
        ? { ...current, text: "", attachments: undefined, poll: undefined, editedAt: undefined, deletedAt: external.deletedAt }
        : {
            ...current,
            senderId: external.senderId ? `${platform}:${external.senderId}` : current.senderId,
            senderName: external.senderName,
            text: external.text.slice(0, 4_000),
            type: external.type,
            editedAt: external.editedAt ?? current.editedAt,
          };
      if (JSON.stringify(updated) === JSON.stringify(current)) return;
      this.storeUpdatedMessage(updated);
      this.broadcast(JSON.stringify({ type: external.deletedAt ? "message-deleted" : "message-edited", message: updated }));
      return;
    }
    if (external.sourceNativeId) {
      const nativeMessage = this.findMessage(external.sourceNativeId);
      if (nativeMessage) {
        this.linkExternalMessage(platform, external.externalId, nativeMessage.id);
        this.updateExternalDelivery(nativeMessage.id, { platform, status: "sent" });
        return;
      }
    }
    if (objectionableContentReason(external.text)) return;
    const parentNativeId = external.replyToExternalId
      ? this.nativeIdForExternal(platform, external.replyToExternalId)
      : null;
    const parent = parentNativeId ? this.findMessage(parentNativeId) : null;
    const nativeId = `external:${platform}:${external.externalId}`;
    const message: ChatMessage = {
      id: nativeId,
      orgId: this.orgId,
      senderId: external.senderId ? `${platform}:${external.senderId}` : undefined,
      senderName: external.senderName,
      text: external.text.slice(0, 4_000),
      type: external.type,
      timestamp: external.timestamp,
      roomId: this.roomId,
      threadRootId: parent ? parent.threadRootId ?? parent.id : undefined,
      replyTo: parent
        ? { messageId: parent.id, senderName: parent.senderName.slice(0, 80), text: parent.text.slice(0, 240) }
        : undefined,
      external: { platform, id: external.externalId },
    };
    this.persistMessage(message);
    this.linkExternalMessage(platform, external.externalId, nativeId);
    this.recentMessages = [...this.recentMessages, message]
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
      .slice(-this.HYDRATION_MESSAGE_LIMIT);
    this.broadcast(JSON.stringify({ type: "message", message }));
  }

  private async syncExternalGateway(): Promise<number | null> {
    if (this.roomId !== "production" || !this.orgId) return null;
    let platform: ExternalChatPlatform | null = null;
    try {
      const config = await loadExternalChatConfiguration(this.env.DB, this.orgId);
      if (!config) {
        this.publishGatewayStatus({ type: "gateway-status", platform: null, status: "disabled" });
        return null;
      }
      platform = config.platform;
      if (this.lastGatewayStatus?.platform !== platform || this.lastGatewayStatus.status !== "connected") {
        this.publishGatewayStatus({ type: "gateway-status", platform, status: "connecting" });
      }
      const cursor = this.ctx.storage.sql.exec<{ cursor: string | null }>(
        "SELECT cursor FROM external_chat_sync WHERE platform = ? LIMIT 1",
        platform,
      ).toArray()[0]?.cursor ?? null;
      const history = await fetchExternalChatHistory(config, cursor);
      for (const message of history.messages) this.importExternalMessage(platform, message);
      this.ctx.storage.sql.exec(
        `INSERT INTO external_chat_sync (platform, cursor, synced_at) VALUES (?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET cursor = excluded.cursor, synced_at = excluded.synced_at`,
        platform,
        history.nextCursor,
        Date.now(),
      );
      this.publishGatewayStatus({ type: "gateway-status", platform, status: "connected" });
      return externalChatPollInterval(platform);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "External chat synchronization failed";
      this.publishGatewayStatus({ type: "gateway-status", platform, status: "error", error: detail.slice(0, 240) });
      console.error(JSON.stringify({
        message: "external chat synchronization failed",
        orgId: this.orgId,
        platform,
        error: detail,
      }));
      return 60_000;
    }
  }

  private async syncAndScheduleExternalGateway(): Promise<void> {
    const interval = await this.syncExternalGateway();
    if (interval && this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + interval);
    }
  }

  async alarm(): Promise<void> {
    await this.ensureHistoryLoaded();
    if (this.ctx.getWebSockets().length === 0) return;
    await this.enqueueGatewayOperation(() => this.syncAndScheduleExternalGateway());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.ensureHistoryLoaded();

    if (url.pathname === "/internal/delete-user-data" && request.method === "POST") {
      const suppliedSecret = request.headers.get("x-showpilot-internal-secret");
      if (!this.env.BETTER_AUTH_SECRET || suppliedSecret !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body: { userId?: unknown } = await request.json<{ userId?: unknown }>().catch(() => ({}));
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!userId || userId.length > 200) return new Response("Bad Request", { status: 400 });
      return Response.json(await this.deleteUserData(userId));
    }

    const requestedOrgId = url.searchParams.get("orgId") ?? "";
    const requestedRoomId = url.searchParams.get("room") ?? "production";
    if (!this.setContext(requestedOrgId, requestedRoomId)) {
      return new Response("Chat room mismatch", { status: 403 });
    }

    if (url.pathname === "/external/import" && request.method === "POST") {
      if (url.searchParams.get("access") !== "external" || this.roomId !== "production") {
        return new Response("Unauthorized", { status: 401 });
      }
      const parsed = parseExternalImport(await request.json<unknown>().catch(() => null));
      if (!parsed) return new Response("Bad Request", { status: 400 });
      this.importExternalMessage(parsed.platform, parsed.message);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.set(server, {
        userId: url.searchParams.get("userId") ?? undefined,
        name: url.searchParams.get("name") ?? "Gateway",
        role: url.searchParams.get("role") ?? undefined,
        orgId: this.orgId,
        roomId: this.roomId,
      });
      server.serializeAttachment?.(this.sessions.get(server));

      // Send recent messages for hydration
      server.send(
        JSON.stringify({
          type: "hydrate",
          messages: this.recentMessages,
          readReceipts: this.isDirectMessageRoom(this.roomId) ? this.getReadReceipts() : undefined,
        })
      );
      if (this.lastGatewayStatus) server.send(JSON.stringify(this.lastGatewayStatus));
      if (this.roomId === "production") {
        this.ctx.waitUntil(
          this.enqueueGatewayOperation(() => this.syncAndScheduleExternalGateway()).catch(() => undefined),
        );
      }

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
        orgId: this.orgId,
        senderId: body.senderId,
        senderName: body.senderName ?? "Unknown",
        senderRole: body.senderRole,
        text,
        type: messageType,
        timestamp: Date.now(),
        roomId: this.roomId,
      };

      this.addMessage(message);
      this.broadcast(JSON.stringify({ type: "message", message }));
      this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMessage(message)).catch(() => undefined));

      return Response.json({ ok: true, message });
    }

    if (url.pathname === "/history") {
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 200))
        : 100;
      const beforeTimestamp = Number(url.searchParams.get("beforeTimestamp"));
      const beforeId = url.searchParams.get("beforeId") ?? "";
      const hasCursor = Number.isFinite(beforeTimestamp) && beforeTimestamp > 0 && beforeId.length > 0 && beforeId.length <= 128;
      const rows = hasCursor
        ? this.ctx.storage.sql.exec<{ payload: string }>(
            `SELECT payload FROM chat_messages
             WHERE timestamp < ? OR (timestamp = ? AND id < ?)
             ORDER BY timestamp DESC, id DESC LIMIT ?`,
            beforeTimestamp,
            beforeTimestamp,
            beforeId,
            limit,
          ).toArray()
        : this.ctx.storage.sql.exec<{ payload: string }>(
            "SELECT payload FROM chat_messages ORDER BY timestamp DESC, id DESC LIMIT ?",
            limit,
          ).toArray();
      const messages = rows.flatMap((row) => {
        try { return [JSON.parse(row.payload) as ChatMessage]; } catch { return []; }
      }).reverse();
      const oldest = messages[0];
      return Response.json({
        messages,
        nextCursor: rows.length === limit && oldest
          ? { timestamp: oldest.timestamp, id: oldest.id }
          : null,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      // A hibernated Durable Object can wake directly into a WebSocket event,
      // without another fetch() call to restore the in-memory working set.
      await this.ensureHistoryLoaded();
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
        poll?: ChatMessage["poll"];
        clientMessageId?: string;
        messageId?: string;
        requestId?: string;
        optionId?: string;
        emoji?: string;
        typing?: boolean;
        readAt?: number;
      };

      if (parsed.type === "identify") {
        // Identity is established by the Worker gateway, never by a client frame.
        return;
      }

      const session = this.getSession(ws);
      if (!session) return;

      if (parsed.type === "typing") {
        this.broadcast(JSON.stringify({
          type: "typing",
          userId: session.userId,
          name: session.name,
          typing: parsed.typing === true,
        }), ws);
        return;
      }

      if (parsed.type === "read") {
        if (!session.userId || !this.isDirectMessageRoom(session.roomId) || !session.roomId.split(":").slice(1).includes(session.userId)) return;
        const readAt = Math.max(0, Math.min(Date.now(), Math.floor(Number(parsed.readAt) || 0)));
        if (!readAt) return;
        this.ctx.storage.sql.exec(
          `INSERT INTO chat_reads (user_id, read_at) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
          session.userId,
          readAt,
        );
        this.broadcast(JSON.stringify({ type: "read-receipt", userId: session.userId, readAt }));
        return;
      }

      if (parsed.type === "message") {
        const contentError = objectionableContentReason(parsed.text ?? "");
        if (contentError) {
          ws.send(JSON.stringify({ type: "error", error: contentError }));
          return;
        }
        const clientMessageId = typeof parsed.clientMessageId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.clientMessageId)
          ? parsed.clientMessageId
          : crypto.randomUUID();
        const existingMessage = this.findMessage(clientMessageId);
        if (existingMessage) {
          ws.send(JSON.stringify({ type: "message", message: existingMessage }));
          return;
        }
        const replyTo = this.cleanReply(parsed.replyTo);
        const replyParent = replyTo ? this.findMessage(replyTo.messageId) : null;
        const message: ChatMessage = {
          id: clientMessageId,
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
          threadRootId: replyParent ? replyParent.threadRootId ?? replyParent.id : undefined,
          replyTo,
          attachments: this.cleanAttachments(parsed.attachments, session.orgId),
          poll: this.cleanPoll(parsed.poll),
        };

        if (!message.text && !message.attachments?.length && !message.poll) return;
        this.addMessage(message);
        this.broadcast(JSON.stringify({ type: "message", message }));
        this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMessage(message)).catch(() => undefined));
        return;
      }

      if (parsed.type === "vote") {
        const respond = (ok: boolean, error?: string) => ws.send(JSON.stringify({ type: "mutation-result", requestId: parsed.requestId, ok, error }));
        if (!session.userId || !parsed.messageId || !parsed.optionId || !parsed.requestId) { respond(false, "Sign in to vote"); return; }
        const current = this.findMessage(parsed.messageId);
        if (!current?.poll || current.deletedAt) { respond(false, "Poll no longer exists"); return; }
        if (!current.poll.options.some((option) => option.id === parsed.optionId)) { respond(false, "Poll option not found"); return; }
        const poll = {
          ...current.poll,
          options: current.poll.options.map((option) => ({
            ...option,
            voterIds: option.id === parsed.optionId
              ? [...option.voterIds.filter((id) => id !== session.userId), session.userId!]
              : option.voterIds.filter((id) => id !== session.userId),
          })),
        };
        const updated = { ...current, poll };
        this.storeUpdatedMessage(updated);
        this.broadcast(JSON.stringify({ type: "message-edited", message: updated }));
        respond(true);
        return;
      }

      if (parsed.type === "reaction") {
        const respond = (ok: boolean, error?: string) => ws.send(JSON.stringify({ type: "mutation-result", requestId: parsed.requestId, ok, error }));
        const emoji = typeof parsed.emoji === "string" && parsed.emoji.length <= 32 && /\p{Extended_Pictographic}/u.test(parsed.emoji)
          ? parsed.emoji
          : null;
        const userId = session.userId;
        if (!userId || !parsed.messageId || !parsed.requestId || !emoji) { respond(false, "Invalid reaction"); return; }
        const current = this.findMessage(parsed.messageId);
        if (!current || current.deletedAt) { respond(false, "Message no longer exists"); return; }
        const reactions = [...(current.reactions ?? [])];
        const reactionIndex = reactions.findIndex((reaction) => reaction.emoji === emoji);
        if (reactionIndex < 0) reactions.push({ emoji, userIds: [userId] });
        else {
          const active = reactions[reactionIndex].userIds.includes(userId);
          const userIds = active ? reactions[reactionIndex].userIds.filter((id) => id !== userId) : [...reactions[reactionIndex].userIds, userId];
          if (userIds.length) reactions[reactionIndex] = { ...reactions[reactionIndex], userIds };
          else reactions.splice(reactionIndex, 1);
        }
        const updated = { ...current, reactions };
        this.storeUpdatedMessage(updated);
        this.broadcast(JSON.stringify({ type: "message-edited", message: updated }));
        respond(true);
        return;
      }

      if (parsed.type === "edit" || parsed.type === "delete") {
        const respond = (ok: boolean, error?: string) => ws.send(JSON.stringify({ type: "mutation-result", requestId: parsed.requestId, ok, error }));
        if (!session?.userId || !parsed.messageId || !parsed.requestId) { respond(false, "Invalid message update"); return; }
        const current = this.findMessage(parsed.messageId);
        if (!current) { respond(false, "Message no longer exists"); return; }
        if (current.senderId !== session.userId) { respond(false, "You can only change your own messages"); return; }
        if (current.deletedAt) { respond(false, "Message is already deleted"); return; }
        const now = Date.now();
        const updated: ChatMessage = parsed.type === "delete"
          ? { ...current, text: "", attachments: undefined, poll: undefined, deletedAt: now, editedAt: undefined }
          : { ...current, text: (parsed.text ?? "").trim().slice(0, 4000), editedAt: now };
        if (parsed.type === "edit" && !updated.text) { respond(false, "Message cannot be empty"); return; }
        this.storeUpdatedMessage(updated);
        this.broadcast(JSON.stringify({ type: parsed.type === "delete" ? "message-deleted" : "message-edited", message: updated }));
        respond(true);
        this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMutation(updated, parsed.type === "delete")).catch(() => undefined));
      }
    } catch {
      // Ignore malformed messages
    }
  }

  webSocketClose(ws: WebSocket) {
    this.clearTyping(ws);
    this.sessions.delete(ws);
    if (this.ctx.getWebSockets().length === 0) this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }

  webSocketError(ws: WebSocket) {
    this.clearTyping(ws);
    this.sessions.delete(ws);
    if (this.ctx.getWebSockets().length === 0) this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }

  private addMessage(message: ChatMessage) {
    this.persistMessage(message);
    const existing = this.recentMessages.findIndex((candidate) => candidate.id === message.id);
    if (existing >= 0) {
      const nextMessages = [...this.recentMessages];
      nextMessages[existing] = message;
      this.recentMessages = nextMessages;
      return;
    }
    this.recentMessages = [...this.recentMessages, message].slice(-this.HYDRATION_MESSAGE_LIMIT);
  }

  private cleanReply(reply: ChatMessage["replyTo"]): ChatMessage["replyTo"] {
    if (!reply?.messageId) return undefined;
    const original = this.findMessage(String(reply.messageId));
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

  private cleanPoll(poll: ChatMessage["poll"]): ChatMessage["poll"] {
    const question = String(poll?.question ?? "").trim().slice(0, 240);
    if (!question || !Array.isArray(poll?.options)) return undefined;
    const options = poll.options.slice(0, 6).flatMap((option) => {
      const text = String(option?.text ?? "").trim().slice(0, 120);
      return text ? [{ id: crypto.randomUUID(), text, voterIds: [] }] : [];
    });
    return options.length >= 2 ? { question, options } : undefined;
  }

  private async deleteUserData(userId: string): Promise<{ messagesDeleted: number; filesDeleted: number }> {
    const rows = this.ctx.storage.sql.exec<{ id: string; payload: string }>(
      "SELECT id, payload FROM chat_messages ORDER BY timestamp ASC, id ASC",
    ).toArray();
    const parsedRows = rows.flatMap((row) => {
      try {
        return [{ id: row.id, message: JSON.parse(row.payload) as ChatMessage }];
      } catch {
        return [];
      }
    });
    const scrubbed = scrubDeletedUserFromChat(parsedRows.map(({ message }) => message), userId);
    const authoredIds = new Set(scrubbed.deleted.map((message) => message.id));
    const attachmentKeys = scrubbed.deleted.flatMap((message) =>
      (message.attachments ?? []).flatMap((attachment) => {
        try {
          const path = new URL(attachment.url, "https://showpilot.local").pathname;
          const match = path.match(/^\/api\/chat-file\/([^/]+)\/([^/]+)\/([^/]+)$/);
          if (!match || decodeURIComponent(match[1]) !== message.orgId) return [];
          return [`orgs/${message.orgId}/chat/${decodeURIComponent(match[2])}/${decodeURIComponent(match[3])}`];
        } catch {
          return [];
        }
      }),
    );

    for (const { id } of parsedRows) {
      if (authoredIds.has(id)) {
        this.ctx.storage.sql.exec("DELETE FROM chat_messages WHERE id = ?", id);
      }
    }
    for (const message of scrubbed.messages) this.persistMessage(message);
    this.ctx.storage.sql.exec("DELETE FROM chat_reads WHERE user_id = ?", userId);
    if (attachmentKeys.length && this.env.STORAGE) await this.env.STORAGE.delete(attachmentKeys);

    this.recentMessages = scrubbed.messages.slice(-this.HYDRATION_MESSAGE_LIMIT);
    return { messagesDeleted: scrubbed.deleted.length, filesDeleted: attachmentKeys.length };
  }

  private getSession(ws: WebSocket) {
    const session = this.sessions.get(ws) ??
      (ws.deserializeAttachment?.() as { userId?: string; name: string; role?: string; orgId: string; roomId: string } | null);
    if (session) this.sessions.set(ws, session);
    return session;
  }

  private isDirectMessageRoom(roomId: string): boolean {
    return /^dm:[^:]+:[^:]+$/.test(roomId);
  }

  private getReadReceipts(): Record<string, number> {
    return Object.fromEntries(this.ctx.storage.sql.exec<{ user_id: string; read_at: number }>(
      "SELECT user_id, read_at FROM chat_reads",
    ).toArray().map((row) => [row.user_id, row.read_at]));
  }

  private clearTyping(ws: WebSocket) {
    const session = this.getSession(ws);
    if (session) this.broadcast(JSON.stringify({ type: "typing", userId: session.userId, name: session.name, typing: false }), ws);
  }

  private broadcast(data: string, exclude?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }

  private publishGatewayStatus(status: GatewayStatusFrame) {
    const previous = this.lastGatewayStatus;
    if (previous
      && previous.platform === status.platform
      && previous.status === status.status
      && previous.error === status.error) return;
    this.lastGatewayStatus = status;
    this.broadcast(JSON.stringify(status));
  }
}
