import { chatRoomClearSchema, chatClearReceiptSchema, type ChatRoomClear } from "@/lib/chat-history-clear-contract";
import { chatUploadSpecSchema } from "@showpilot/shared/chat-attachment";
import { ChatAttachmentStorageError, cancelChatUpload, chatUploadFileKey, reserveChatUpload, chatFileIsDeleted, eraseChatAttachment } from "@/lib/chat-attachment-storage.server";
import { chatEditTime, chatMutationCommandSchema, chatMutationResultSchema, type ChatMutationCommand, type ChatMutationResult } from "@showpilot/shared/chat-mutation";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { chatPassIsRevoked } from "@/lib/chat-pass-revocation.server";
import { reportRelayError } from "@/lib/operational-errors.server";
import { DurableObject } from "cloudflare:workers";
import { renewSocketReadLease, socketReadLeaseAllows, refreshSocketReadLeases, scheduleSocketReadRefresh, socketAuthorityClaim } from "@/lib/socket-read-authority.server";
import { scrubDeletedUserFromChat } from "@/lib/chat-account-deletion";
import { objectionableContentReason } from "@/lib/user-content-safety";
import { crewMessageDeliverySchema, type CrewMessageDelivery, type CrewMessageResult } from "@/lib/crew-message";
import {
  externalChatPollInterval,
  fetchExternalChatHistory,
  loadExternalChatConfiguration,
  ExternalChatConfigurationError,
  sendExternalChatMessage,
  updateExternalChatMessage,
  type ExternalChatMessage,
  type ExternalChatPlatform,
} from "@/lib/external-chat-gateway";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
} from "@/lib/live-rundown-authority.server";

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
  CREDENTIAL_ENCRYPTION_KEYS?: string;
};

interface GatewayStatusFrame {
  type: "gateway-status";
  platform: ExternalChatPlatform | null;
  status: "disabled" | "connecting" | "connected" | "error";
  error?: string;
}

type ChatSession = { name: string; orgId: string; roomId: string } & (
  | { kind: "member"; userId: string; role?: string; authClaim: LiveSessionAuthorityClaim }
  | { kind: "guest"; userId?: never; role: "Guest"; workerVerified: true; tokenHash: string; expiresAt: number; attachmentOwnerId?: string }
  | { kind: "viewer"; userId?: never; role?: never }
);

function readChatSession(value: unknown): ChatSession | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.orgId !== "string" || typeof value.roomId !== "string") return null;
  const base = { name: value.name, orgId: value.orgId, roomId: value.roomId };
  if (value.kind === "guest" && value.workerVerified === true && value.userId === undefined && value.role === "Guest"
    && typeof value.tokenHash === "string" && /^sha256:[0-9a-f]{64}$/.test(value.tokenHash)
    && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) {
    return {
      ...base,
      kind: "guest",
      role: "Guest",
      workerVerified: true,
      tokenHash: value.tokenHash,
      expiresAt: value.expiresAt,
      ...(typeof value.attachmentOwnerId === "string" ? { attachmentOwnerId: value.attachmentOwnerId } : {}),
    };
  }
  if (value.role !== undefined && typeof value.role !== "string") return null;
  if (value.kind === "member" && typeof value.userId === "string" && value.userId.length > 0) {
    const authClaim = isRecord(value.authClaim)
      && typeof value.authClaim.userId === "string"
      && typeof value.authClaim.sessionId === "string"
      && typeof value.authClaim.orgId === "string"
      ? {
          userId: value.authClaim.userId,
          sessionId: value.authClaim.sessionId,
          orgId: value.authClaim.orgId,
        }
      : undefined;
    if (!authClaim || authClaim.userId !== value.userId || authClaim.orgId !== base.orgId) return null;
    return { ...base, kind: "member", userId: value.userId, role: value.role, authClaim };
  }
  if (value.kind === "viewer" && value.userId === undefined) {
    return { ...base, kind: "viewer" };
  }
  return null;
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
  private sessions: Map<WebSocket, ChatSession> = new Map();
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
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_clear_receipts (
        actor_id TEXT NOT NULL, request_id TEXT NOT NULL, cutoff INTEGER NOT NULL,
        PRIMARY KEY (actor_id,request_id)
      )`);
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chat_cleared_messages (id TEXT PRIMARY KEY)");
      // File IDs are immutable upload identities. Keep only the opaque ID so a
      // delayed attachment validation cannot reuse a file being deleted.
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chat_deleted_attachments (id TEXT PRIMARY KEY)");
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_mutation_receipts (
        actor_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, attachments TEXT, cleanup_state TEXT NOT NULL,
        PRIMARY KEY (actor_id, request_id)
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_automation_receipts (
        execution_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        message_id TEXT NOT NULL
      )`);
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
      reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_gateway_operation", error);
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

  private mutationReceipt(command: ChatMutationCommand) {
    return this.ctx.storage.sql.exec<{ fingerprint: string; result: string; attachments: string | null; cleanup_state: ChatMutationResult["cleanup"] }>(
      "SELECT fingerprint,result,attachments,cleanup_state FROM chat_mutation_receipts WHERE actor_id=? AND request_id=?",
      command.userId, command.requestId,
    ).toArray()[0];
  }

  private mutationStillCurrent(command: ChatMutationCommand, result: ChatMutationResult, message: ChatMessage | null): boolean {
    if (!message) return false;
    const operation = command.operation;
    switch (operation.kind) {
      case "delete": return message.deletedAt === result.at;
      case "edit": return !message.deletedAt && message.editedAt === result.at && message.text === operation.text;
      case "reaction": return !message.deletedAt && Boolean(message.reactions?.some(reaction => reaction.emoji === operation.emoji && reaction.userIds.includes(command.userId))) === operation.active;
      case "vote": return !message.deletedAt && Boolean(message.poll?.options.some(option => option.id === operation.optionId && option.voterIds.includes(command.userId)));
    }
  }

  private async recoverMutationCleanup(command: ChatMutationCommand): Promise<ChatMutationResult["cleanup"]> {
    const receipt = this.mutationReceipt(command);
    if (!receipt || receipt.cleanup_state === "complete" || !receipt.attachments) return "complete";
    // Deletion and its receipt are already durable. A retry can only repeat
    // idempotent object cleanup, never replace a later version of the message.
    try {
      const attachments: NonNullable<ChatMessage["attachments"]> = JSON.parse(receipt.attachments);
      await runRouteLoad(() => this.deleteOwnedUnreferencedAttachments(attachments, command.userId, new Set([command.messageId])), undefined, 5_000);
      this.ctx.storage.sql.exec("UPDATE chat_mutation_receipts SET cleanup_state='complete' WHERE actor_id=? AND request_id=?", command.userId, command.requestId);
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE chat_mutation_receipts SET cleanup_state='failed' WHERE actor_id=? AND request_id=? AND cleanup_state<>'complete'", command.userId, command.requestId);
      reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_attachment_cleanup", error);
    }
    return this.mutationReceipt(command)?.cleanup_state ?? "failed";
  }

  private async applyMessageMutation(ws: WebSocket, session: ChatSession, input: unknown) {
    const parsed = chatMutationCommandSchema.safeParse(input);
    if (!parsed.success || session.kind !== "member" || parsed.data.orgId !== session.orgId || parsed.data.roomId !== session.roomId || parsed.data.userId !== session.userId) {
      ws.send(JSON.stringify({ type: "mutation-error", requestId: isRecord(input) ? input.requestId : undefined, error: "The account or conversation changed. Return to the original account and conversation." }));
      return;
    }
    const command = parsed.data, fingerprint = JSON.stringify(command);
    let receipt = this.mutationReceipt(command);
    if (!receipt && this.wasCleared(command.messageId)) {
      // Cleared identities cannot be reused. Report their absence without
      // storing an old edit draft back into erased chat history.
      ws.send(JSON.stringify({ type: "mutation-result", result: { command, outcome: "not-found", at: Date.now(), cleanup: "complete" } }));
      return;
    }
    if (receipt && receipt.fingerprint !== fingerprint) {
      ws.send(JSON.stringify({ type: "mutation-error", requestId: command.requestId, error: "The original message change was altered. Recover the original request." }));
      return;
    }
    if (!receipt) {
      const current = this.findMessage(command.messageId), operation = command.operation;
      const at = Math.max(Date.now(), current ? chatEditTime(current) + 1 : 0);
      let outcome: ChatMutationResult["outcome"] = "applied";
      let next: ChatMessage | null = null;
      if (command.expiresAt <= Date.now() || command.expiresAt > Date.now() + 15_000) outcome = "expired";
      else if (!current || current.deletedAt) outcome = "not-found";
      else if ((operation.kind === "edit" || operation.kind === "delete") && current.senderId !== session.userId) outcome = "not-owner";
      else {
        switch (operation.kind) {
          case "edit":
          case "delete":
            if (chatEditTime(current) !== operation.expectedEditTime) outcome = "conflict";
            else next = operation.kind === "edit" ? { ...current, text: operation.text, editedAt: at }
              : { ...current, text: "", attachments: undefined, poll: undefined, deletedAt: at, editedAt: undefined };
            break;
          case "reaction": {
            const active = Boolean(current.reactions?.some(reaction => reaction.emoji === operation.emoji && reaction.userIds.includes(session.userId)));
            if (active === operation.active) { outcome = "conflict"; break; }
            const reactions = (current.reactions ?? []).map(reaction => reaction.emoji === operation.emoji
              ? { ...reaction, userIds: operation.active ? [...reaction.userIds, session.userId] : reaction.userIds.filter(id => id !== session.userId) } : reaction).filter(reaction => reaction.userIds.length);
            if (operation.active && !reactions.some(reaction => reaction.emoji === operation.emoji)) reactions.push({ emoji: operation.emoji, userIds: [session.userId] });
            next = { ...current, reactions }; break;
          }
          case "vote": {
            if (!current.poll?.options.some(option => option.id === operation.optionId)) { outcome = "invalid-option"; break; }
            const selected = current.poll.options.find(option => option.voterIds.includes(session.userId))?.id ?? null;
            if (selected !== operation.expectedOptionId) { outcome = "conflict"; break; }
            next = { ...current, poll: { ...current.poll, options: current.poll.options.map(option => ({ ...option,
              voterIds: option.id === operation.optionId ? [...option.voterIds.filter(id => id !== session.userId), session.userId] : option.voterIds.filter(id => id !== session.userId),
            })) } }; break;
          }
        }
      }
      const attachments = next && operation.kind === "delete" ? current?.attachments : undefined;
      const result: ChatMutationResult = { command, outcome, at, cleanup: attachments?.length ? "pending" : "complete" };
      this.ctx.storage.transactionSync(() => {
        if (next) this.persistMessage(next);
        this.ctx.storage.sql.exec("INSERT INTO chat_mutation_receipts(actor_id,request_id,fingerprint,result,attachments,cleanup_state) VALUES(?,?,?,?,?,?)",
          session.userId, command.requestId, fingerprint, JSON.stringify(result), attachments?.length ? JSON.stringify(attachments) : null, result.cleanup);
      });
      if (next) {
        const updated = next;
        this.recentMessages = this.recentMessages.map(message => message.id === updated.id ? updated : message);
        this.broadcast(JSON.stringify({ type: operation.kind === "delete" ? "message-deleted" : "message-edited", message: updated }));
        if (operation.kind === "edit" || operation.kind === "delete") this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMutation(updated, operation.kind === "delete")).catch(() => undefined));
      }
      receipt = this.mutationReceipt(command);
    }
    if (!receipt) throw new Error("Message change receipt was not saved.");
    const saved = chatMutationResultSchema.parse(JSON.parse(receipt.result));
    const cleanup = await this.recoverMutationCleanup(command);
    const current = this.findMessage(command.messageId);
    const result: ChatMutationResult = { ...saved, cleanup, outcome: saved.outcome === "applied" && !this.mutationStillCurrent(command, saved, current) ? "superseded" : saved.outcome };
    // Reconciliation sends the current projection, never the old receipt's copy.
    if (current) ws.send(JSON.stringify({ type: current.deletedAt ? "message-deleted" : "message-edited", message: current }));
    ws.send(JSON.stringify({ type: "mutation-result", result }));
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
    let config;
    try {
      config = await loadExternalChatConfiguration(this.env.DB, this.orgId, this.env.CREDENTIAL_ENCRYPTION_KEYS);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : "Linked chat configuration is unavailable.").slice(0, 240);
      if (error instanceof ExternalChatConfigurationError) {
        this.updateExternalDelivery(message.id, { platform: error.platform, status: "failed", error: detail });
      }
      this.publishGatewayStatus({ type: "gateway-status", platform: error instanceof ExternalChatConfigurationError ? error.platform : null, status: "error", error: detail });
      throw error;
    }
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
    const config = await loadExternalChatConfiguration(this.env.DB, this.orgId, this.env.CREDENTIAL_ENCRYPTION_KEYS);
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
    const cutoff=this.ctx.storage.sql.exec<{cutoff:number|null}>("SELECT MAX(cutoff) AS cutoff FROM chat_clear_receipts").toArray()[0]?.cutoff;
    if((cutoff !== null && cutoff !== undefined && external.timestamp<=cutoff) || (external.sourceNativeId && this.wasCleared(external.sourceNativeId))) return;
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
      const config = await loadExternalChatConfiguration(this.env.DB, this.orgId, this.env.CREDENTIAL_ENCRYPTION_KEYS);
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
      reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_gateway_sync", error);
      return 60_000;
    }
  }

  private async syncAndScheduleExternalGateway(): Promise<void> {
    const interval = await this.syncExternalGateway();
    let nextAlarm: number | null = interval ? Date.now() + interval : null;
    let activeConnections = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const session = this.getSession(socket);
      if (!session) continue;
      activeConnections += 1;
      if (session.kind === "guest") {
        nextAlarm = Math.min(nextAlarm ?? session.expiresAt, session.expiresAt);
      }
    }
    await scheduleSocketReadRefresh(this.ctx, socket => readChatSession(socket.deserializeAttachment())?.kind !== "viewer",
      activeConnections > 0 ? nextAlarm : null);
  }

  async alarm(): Promise<void> {
    await this.ensureHistoryLoaded();
    await this.refreshReadAuthority();
    // Close expired guests before gateway I/O or any further room broadcast.
    for (const socket of this.ctx.getWebSockets()) this.getSession(socket);
    if (this.ctx.getWebSockets().length === 0) return;
    await this.enqueueGatewayOperation(() => this.syncAndScheduleExternalGateway());
  }

  /** Worker-only RPC. Public chat routes cannot choose automation identity. */
  async postAutomationCue(input: CrewMessageDelivery): Promise<CrewMessageResult> {
    const parsed = crewMessageDeliverySchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid crew message delivery." };
    const delivery = parsed.data;
    const { authority, orgId } = delivery;
    if (authority.orgId !== orgId) return { ok: false, error: "Crew message organization mismatch." };
    const [canControl, canChat, actor, digest] = await Promise.all([
      hasLivePermissionAuthority(this.env.DB, authority, "timecode:access"),
      hasLivePermissionAuthority(this.env.DB, authority, "chat:access"),
      this.env.DB.prepare(`SELECT user.name, member.role FROM member JOIN user ON user.id = member.userId
        WHERE member.organizationId = ? AND member.userId = ?
        AND EXISTS (SELECT 1 FROM rundown WHERE id = ? AND orgId = ?) LIMIT 1`)
        .bind(orgId, authority.userId, delivery.showId, orgId).first<{ name: string; role: string }>(),
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([delivery.showId, delivery.eventId, delivery.payload.message]))),
    ]);
    if (!canControl || !canChat || !actor) return { ok: false, error: "Crew messages require current timecode and chat access to this show's organization." };
    await this.ensureHistoryLoaded();
    if (delivery.deadline <= Date.now() || delivery.deadline > Date.now() + 10000) return { ok: false, error: "Crew message delivery expired. Review chat before retrying." };
    if (!this.setContext(orgId, "production")) return { ok: false, error: "Crew messages can only post to this organization's Production Chat." };
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const receipt = this.ctx.storage.sql.exec<{ fingerprint: string; message_id: string }>(
      "SELECT fingerprint, message_id FROM chat_automation_receipts WHERE execution_id = ?", delivery.executionId,
    ).toArray()[0];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) return { ok: false, error: "This delivery already posted different content. Review chat and re-arm the cue to send a new message." };
      return { ok: true, messageId: receipt.message_id, duplicate: true };
    }
    const message: ChatMessage = {
      id: `automation:${delivery.executionId}`,
      orgId,
      senderId: authority.userId,
      senderName: `${actor.name} · Automation`,
      senderRole: actor.role,
      text: delivery.payload.message,
      type: "cue",
      roomId: "production",
      timestamp: Date.now(),
    };
    // No await between duplicate check and commit. A lost reply is safe to retry,
    // even after hibernation or after the original message was edited/deleted.
    this.ctx.storage.transactionSync(() => {
      this.persistMessage(message);
      this.ctx.storage.sql.exec("INSERT INTO chat_automation_receipts (execution_id, fingerprint, message_id) VALUES (?, ?, ?)", delivery.executionId, fingerprint, message.id);
    });
    this.recentMessages = [...this.recentMessages, message].slice(-this.HYDRATION_MESSAGE_LIMIT);
    this.broadcast(JSON.stringify({ type: "message", message }));
    this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMessage(message)).catch(() => undefined));
    return { ok: true, messageId: message.id, duplicate: false };
  }

  /** Worker-only destructive RPC, authorized against a durable organization receipt. */
  async clearHistory(input: ChatRoomClear): Promise<{ cleared: true } | { cleared: false; error: string }> {
    const parsed = chatRoomClearSchema.safeParse(input);
    if(!parsed.success) return {cleared:false,error:"Invalid chat clear delivery."};
    const command = parsed.data;
    if(command.authority.orgId !== command.orgId) return {cleared:false,error:"Chat clear organization mismatch."};
    await this.ensureHistoryLoaded();
    const receiptRow = await this.env.DB.prepare("SELECT confirmName,cutoff,rooms FROM chat_history_clear_receipt WHERE orgId=? AND actorId=? AND requestId=?")
      .bind(command.orgId,command.authority.userId,command.requestId).first();
    if(!receiptRow) return {cleared:false,error:"Chat clear receipt is missing."};
    const receipt = chatClearReceiptSchema.parse(receiptRow);
    if(receipt.confirmName !== command.confirmName || !receipt.rooms.includes(command.roomId)) return {cleared:false,error:"Chat clear receipt does not include this room."};
    if(!await hasLivePermissionAuthority(this.env.DB,command.authority,"settings:danger_zone")) return {cleared:false,error:"Chat clear access changed."};
    if(command.deadline <= Date.now() || command.deadline > Date.now()+10_000) return {cleared:false,error:"Chat clear delivery expired."};
    if(!this.setContext(command.orgId,command.roomId)) return {cleared:false,error:"Chat clear room mismatch."};
    const existing = this.ctx.storage.sql.exec("SELECT request_id FROM chat_clear_receipts WHERE actor_id=? AND request_id=?",command.authority.userId,command.requestId).toArray();
    if(!existing.length) {
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chat_cleared_messages(id) SELECT id FROM chat_messages WHERE timestamp<=?",receipt.cutoff);
        // Edit recovery carries the original draft. Erasing history must erase
        // those drafts too; a replay can only report the missing message.
        this.ctx.storage.sql.exec("DELETE FROM chat_mutation_receipts WHERE json_extract(result,'$.command.operation.kind')='edit' AND json_extract(result,'$.command.messageId') IN (SELECT id FROM chat_messages WHERE timestamp<=?)", receipt.cutoff);
        this.ctx.storage.sql.exec("DELETE FROM chat_messages WHERE timestamp<=?",receipt.cutoff);
        this.ctx.storage.sql.exec("INSERT INTO chat_clear_receipts(actor_id,request_id,cutoff) VALUES(?,?,?)",command.authority.userId,command.requestId,receipt.cutoff);
        // Replies sent during a delayed clear keep their new text but not a quote of erased history.
        for(const row of this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM chat_messages").toArray()) {
          const message: ChatMessage = JSON.parse(row.payload);
          if(message.replyTo && this.wasCleared(message.replyTo.messageId)) delete message.replyTo;
          if(message.threadRootId && this.wasCleared(message.threadRootId)) delete message.threadRootId;
          this.persistMessage(message);
        }
      });
      const rows=this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM chat_messages ORDER BY timestamp DESC,id DESC LIMIT ?",this.HYDRATION_MESSAGE_LIMIT).toArray().reverse();
      this.recentMessages=rows.map(row=>JSON.parse(row.payload));
    }
    // A replay publishes current history, never the old cleared snapshot.
    this.broadcast(JSON.stringify({type:"hydrate",historyCleared:true,historyClearVersion:this.historyClearVersion(),messages:this.recentMessages,readReceipts:this.getReadReceipts()}));
    return {cleared:true};
  }

  private historyClearVersion(): number {
    return this.ctx.storage.sql.exec<{version:number}>("SELECT COUNT(*) AS version FROM chat_clear_receipts").toArray()[0].version;
  }

  private wasCleared(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT id FROM chat_cleared_messages WHERE id=?",id).toArray().length>0;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // A resumed organization deletion may purge this instance again after its
    // SQL tables were dropped. Authorize and purge before loading any history.
    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      const suppliedSecret = request.headers.get("x-showpilot-internal-secret");
      if (!this.env.BETTER_AUTH_SECRET || suppliedSecret !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      await this.ctx.storage.deleteAll();
      this.sessions.clear();
      this.recentMessages = [];
      this.historyLoad = null;
      this.lastGatewayStatus = null;
      return Response.json({ ok: true });
    }

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

    if (url.pathname === "/internal/external-import" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET || this.roomId !== "production") {
        return new Response("Unauthorized", { status: 401 });
      }
      const parsed = parseExternalImport(await request.json<unknown>().catch(() => null));
      if (!parsed) return new Response("Bad Request", { status: 400 });
      this.importExternalMessage(parsed.platform, parsed.message);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws" || url.pathname === "/internal/guest-ws") {
      const base = { name: url.searchParams.get("name") ?? "Viewer", orgId: this.orgId, roomId: this.roomId };
      let session: ChatSession;
      if (url.pathname === "/internal/guest-ws") {
        if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET || this.roomId !== "production") {
          return new Response("Unauthorized", { status: 401 });
        }
        const expiresAt = Number(url.searchParams.get("guestExpiresAt"));
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return new Response("Guest pass expired", { status: 401 });
        const tokenHash = url.searchParams.get("guestTokenHash");
        if (!tokenHash || !/^sha256:[0-9a-f]{64}$/.test(tokenHash)) return new Response("Guest token identity required", { status: 401 });
        if (await chatPassIsRevoked(this.env.DB, this.orgId, tokenHash)) return new Response("Guest pass revoked", { status: 401 });
        const attachmentOwnerId = url.searchParams.get("attachmentOwnerId") ?? undefined;
        session = { ...base, kind: "guest", role: "Guest", workerVerified: true, tokenHash, expiresAt, attachmentOwnerId };
      } else {
        if (url.searchParams.get("role") === "Guest") return new Response("Guest authority required", { status: 401 });
        session = await this.readMemberSession(url) ?? { ...base, kind: "viewer" };
        if (session.kind === "viewer" && (url.searchParams.has("authUserId") || url.searchParams.has("authSessionId"))) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.set(server, session);
      server.serializeAttachment(session);
      if (session.kind !== "viewer") renewSocketReadLease(server);
      await scheduleSocketReadRefresh(this.ctx, socket => readChatSession(socket.deserializeAttachment())?.kind !== "viewer",
        await this.ctx.storage.getAlarm());

      // Send recent messages for hydration
      server.send(
        JSON.stringify({
          type: "hydrate",
          serverTime: Date.now(),
          historyClearVersion: this.historyClearVersion(),
          messages: this.recentMessages,
          readReceipts: this.getReadReceipts(),
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
      const session = await this.readMemberSession(url);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json()) as Partial<ChatMessage>;
      const text = (body.text ?? "").trim().slice(0, 4000);
      if (!text) return new Response("Bad Request", { status: 400 });
      const messageType = body.type === "alert" || body.type === "cue" || body.type === "system"
        ? body.type
        : "text";
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        orgId: this.orgId,
        senderId: session.userId,
        senderName: session.name,
        senderRole: session.role,
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

    if (url.pathname === "/internal/attachment-state" && request.method === "GET") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) return new Response("Unauthorized", { status: 401 });
      const attachmentUrl = url.searchParams.get("url") ?? "";
      const resolved = this.attachmentStorageKey({ id: "", name: "", url: attachmentUrl, mimeType: "", size: 0 }, this.orgId);
      if (!resolved) return new Response("Invalid attachment", { status: 400 });
      return Response.json({ deleted: this.attachmentWasDeleted(resolved.id) });
    }

    if (url.pathname === "/internal/cancel-upload" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) return new Response("Unauthorized", { status: 401 });
      const input: unknown = await request.json().catch(() => null);
      if (!isRecord(input) || typeof input.ownerId !== "string" || !input.ownerId || input.ownerId.length > 220) return new Response("Invalid upload cancellation", { status: 400 });
      const parsed = chatUploadSpecSchema.safeParse(input.spec);
      if (!parsed.success) return new Response("Invalid upload identity", { status: 400 });
      const spec = parsed.data;
      const owner = { orgId: this.orgId, roomId: this.roomId, ownerId: input.ownerId };
      try {
        return await runRouteLoad(async () => {
          // Bind the ID before reserving its deletion. Another actor cannot
          // cancel an existing upload or change its name/room/checksum.
          await reserveChatUpload(this.env.STORAGE, owner, spec);
          if (this.attachmentKeyIsReferenced(chatUploadFileKey(owner.orgId, spec), new Set())) return new Response("This file is attached to a message", { status: 409 });
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chat_deleted_attachments(id) VALUES(?)", spec.uploadId);
          await cancelChatUpload(this.env.STORAGE, owner, spec);
          return new Response(null, { status: 204 });
        }, undefined, 5_000);
      } catch (error) {
        reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_attachment_cleanup", error);
        return new Response(error instanceof ChatAttachmentStorageError ? error.message : "Attachment removal was not confirmed. Retry removing this attachment.",
          { status: error instanceof ChatAttachmentStorageError ? error.status : 503 });
      }
    }

    if (url.pathname === "/internal/discard-attachment" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) return new Response("Unauthorized", { status: 401 });
      const input: unknown = await request.json().catch(() => null);
      if (!isRecord(input) || typeof input.url !== "string" || typeof input.ownerId !== "string" || !input.ownerId || input.ownerId.length > 220) return new Response("Invalid attachment removal", { status: 400 });
      const ownerId = input.ownerId;
      const resolved = this.attachmentStorageKey({ id: "", name: "", url: input.url, mimeType: "", size: 0 }, this.orgId);
      if (!resolved) return new Response("Invalid attachment", { status: 400 });
      try {
        return await runRouteLoad(async () => {
          const object = await this.env.STORAGE.head(resolved.key);
          if (!object) return new Response(null, { status: 404 });
          if (object.customMetadata?.uploadedBy !== ownerId || (object.customMetadata?.roomId ?? "production") !== this.roomId) return new Response("Only the uploader can remove this file", { status: 403 });
          // No await between reading live references and reserving deletion.
          if (this.attachmentKeyIsReferenced(resolved.key, new Set())) return new Response("This file is attached to a message", { status: 409 });
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chat_deleted_attachments(id) VALUES(?)", resolved.id);
          await eraseChatAttachment(this.env.STORAGE, object);
          return new Response(null, { status: 204 });
        }, undefined, 5_000);
      } catch (error) {
        reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_attachment_cleanup", error);
        return new Response("Attachment removal was not confirmed. Retry removing this attachment.", { status: 503 });
      }
    }

    if (url.pathname === "/unread" && request.method === "GET") {
      const userId = url.searchParams.get("userId");
      if (!userId) return new Response("Unauthorized", { status: 401 });
      const rows = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM chat_messages
         WHERE timestamp > COALESCE((SELECT read_at FROM chat_reads WHERE user_id = ?), 0)
           AND COALESCE(json_extract(payload, '$.senderId'), '') <> ?
           AND json_extract(payload, '$.deletedAt') IS NULL`, userId, userId,
      ).toArray();
      return Response.json({ unread: rows[0]?.count ?? 0 });
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
        command?: unknown;
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
      let allowed: boolean;
      try {
        allowed = session.kind === "member" ? await hasLivePermissionAuthority(this.env.DB, session.authClaim, "chat:access")
          : session.kind === "guest" && !await chatPassIsRevoked(this.env.DB, this.orgId, session.tokenHash);
      } catch {
        ws.close(1011, "Chat authorization unavailable. Reconnect.");
        this.sessions.delete(ws);
        return;
      }
      if (!allowed) {
        ws.close(4403, session.kind === "guest" ? "Guest pass revoked" : "Chat access changed");
        this.sessions.delete(ws);
        return;
      }

      renewSocketReadLease(ws);
      if (parsed.type === "mutation") {
        try {
          await this.applyMessageMutation(ws, session, parsed.command);
        } catch (error) {
          reportRelayError(this.ctx, this.env.DB, this.orgId, "chat_mutation", error);
          ws.send(JSON.stringify({ type: "mutation-error", requestId: isRecord(parsed.command) ? parsed.command.requestId : undefined,
            error: "The message change could not be confirmed. Recover the original request to check its result." }));
        }
        return;
      }
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
        if (!session.userId) return;
        if (this.isDirectMessageRoom(session.roomId) && !session.roomId.split(":").slice(1).includes(session.userId)) return;
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
        const requestedMessageId = typeof parsed.clientMessageId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.clientMessageId)
          ? parsed.clientMessageId
          : undefined;
        const contentError = objectionableContentReason(parsed.text ?? "");
        if (contentError) {
          ws.send(JSON.stringify({ type: "error", error: contentError, ...(requestedMessageId ? { messageId: requestedMessageId } : {}) }));
          return;
        }
        const clientMessageId = requestedMessageId ?? crypto.randomUUID();
        if(this.wasCleared(clientMessageId)) {
          ws.send(JSON.stringify({type:"error",messageId:clientMessageId,error:"This message was already cleared from chat history. Write a new message to send it again."}));
          return;
        }
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
          attachments: await this.cleanAttachments(parsed.attachments, session),
          poll: this.cleanPoll(parsed.poll),
        };

        if (Array.isArray(parsed.attachments) && parsed.attachments.some(attachment => {
          const resolved = this.attachmentStorageKey(attachment, session.orgId);
          return resolved && this.attachmentWasDeleted(resolved.id);
        })) {
          ws.send(JSON.stringify({ type: "error", messageId: clientMessageId, error: "An attached file was deleted. Remove it or upload it again before sending." }));
          return;
        }
        if (!message.text && !message.attachments?.length && !message.poll) return;
        if(this.wasCleared(clientMessageId)) {
          ws.send(JSON.stringify({type:"error",messageId:clientMessageId,error:"This message was cleared while it was being sent. Write a new message to send it again."}));
          return;
        }
        this.addMessage(message);
        this.broadcast(JSON.stringify({ type: "message", message }));
        this.ctx.waitUntil(this.enqueueGatewayOperation(() => this.forwardExternalMessage(message)).catch(() => undefined));
        return;
      }

      if (["vote", "reaction", "edit", "delete"].includes(parsed.type)) {
        ws.send(JSON.stringify({ type: "mutation-result", requestId: parsed.requestId, ok: false, error: "Update ShowPilot before changing messages. This version cannot safely recover message changes." }));
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
    // Attachment validation can yield while a clear commits. This newly accepted
    // message belongs after the clear; quotes of cleared messages do not.
    const cutoff=this.ctx.storage.sql.exec<{cutoff:number|null}>("SELECT MAX(cutoff) AS cutoff FROM chat_clear_receipts").toArray()[0]?.cutoff ?? 0;
    message.timestamp=Math.max(Date.now(),message.timestamp,cutoff+1);
    if(message.replyTo && this.wasCleared(message.replyTo.messageId)) delete message.replyTo;
    if(message.threadRootId && this.wasCleared(message.threadRootId)) delete message.threadRootId;
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

  private attachmentStorageKey(
    attachment: NonNullable<ChatMessage["attachments"]>[number],
    orgId: string,
  ): { key: string; id: string; name: string; url: string } | null {
    try {
      const path = new URL(attachment.url, "https://showpilot.local").pathname;
      const match = path.match(/^\/api\/chat-file\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (!match || decodeURIComponent(match[1]) !== orgId) return null;
      const id = decodeURIComponent(match[2]);
      const name = decodeURIComponent(match[3]);
      if (!id || id === "_uploads" || !name) return null;
      return {
        key: `orgs/${orgId}/chat/${id}/${name}`,
        id,
        name,
        url: `/api/chat-file/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
      };
    } catch {
      return null;
    }
  }

  private async cleanAttachments(attachments: ChatMessage["attachments"], session: ChatSession): Promise<ChatMessage["attachments"]> {
    if (!Array.isArray(attachments)) return undefined;
    const expectedUploader = session.kind === "member"
      ? session.userId
      : session.kind === "guest"
        ? session.attachmentOwnerId ?? null
        : null;
    if (!expectedUploader || !this.env.STORAGE) return undefined;
    const clean = (await Promise.all(attachments.slice(0, 6).map(async (attachment) => {
      if (!attachment?.url) return null;
      const resolved = this.attachmentStorageKey(attachment, session.orgId);
      if (!resolved || this.attachmentWasDeleted(resolved.id)) return null;
      const object = await this.env.STORAGE.head(resolved.key);
      if (!object || chatFileIsDeleted(object) || object.customMetadata?.kind === "chat-upload-claim" || this.attachmentWasDeleted(resolved.id)
        || object.customMetadata?.uploadedBy !== expectedUploader
        || (object.customMetadata?.roomId ?? "production") !== session.roomId) return null;
      return {
        id: resolved.id.slice(0, 100),
        name: resolved.name.slice(0, 180),
        url: resolved.url,
        mimeType: String(object.httpMetadata?.contentType || "application/octet-stream").slice(0, 120),
        size: object.size,
      };
    }))).filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);
    return clean.length ? clean : undefined;
  }

  private async deleteOwnedUnreferencedAttachments(
    attachments: NonNullable<ChatMessage["attachments"]>,
    ownerUserId: string,
    excludedMessageIds: Set<string>,
    physicalErasure = false,
  ): Promise<number> {
    if (!this.env.STORAGE) return 0;
    const candidateKeys = new Set(attachments.flatMap((attachment) => {
      const resolved = this.attachmentStorageKey(attachment, this.orgId);
      return resolved ? [resolved.key] : [];
    }));
    if (!candidateKeys.size) return 0;

    let deleted = 0;
    for (const key of candidateKeys) {
      const object = await this.env.STORAGE.head(key);
      if (!object || object.customMetadata?.uploadedBy !== ownerUserId) continue;
      if (chatFileIsDeleted(object) && !physicalErasure) continue;
      // Re-read after the last await. Reserving the immutable file ID and
      // checking references are synchronous with respect to message commits.
      if (this.attachmentKeyIsReferenced(key, excludedMessageIds)) continue;
      const attachment = attachments.find(candidate => this.attachmentStorageKey(candidate, this.orgId)?.key === key);
      const resolved = attachment && this.attachmentStorageKey(attachment, this.orgId);
      if (!resolved) continue;
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chat_deleted_attachments(id) VALUES(?)", resolved.id);
      if (physicalErasure) await this.env.STORAGE.delete(key);
      else await eraseChatAttachment(this.env.STORAGE, object);
      deleted += 1;
    }
    return deleted;
  }

  private attachmentWasDeleted(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT id FROM chat_deleted_attachments WHERE id=?", id).toArray().length > 0;
  }

  private attachmentKeyIsReferenced(key: string, excludedMessageIds: Set<string>): boolean {
    const rows = this.ctx.storage.sql.exec<{ id: string; payload: string }>(
      "SELECT id, payload FROM chat_messages",
    ).toArray();
    for (const row of rows) {
      if (excludedMessageIds.has(row.id)) continue;
      try {
        const message = JSON.parse(row.payload) as ChatMessage;
        if (message.deletedAt) continue;
        for (const attachment of message.attachments ?? []) {
          const resolved = this.attachmentStorageKey(attachment, message.orgId);
          if (resolved?.key === key) return true;
        }
      } catch {
        // An unreadable row cannot safely authorize deleting an object.
        return true;
      }
    }

    return false;
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
    const readMessages = () => this.ctx.storage.sql.exec<{ id: string; payload: string }>(
      "SELECT id, payload FROM chat_messages ORDER BY timestamp ASC, id ASC",
    ).toArray().flatMap((row) => {
      try {
        return [{ id: row.id, message: JSON.parse(row.payload) as ChatMessage }];
      } catch {
        return [];
      }
    });
    const scrubbed = scrubDeletedUserFromChat(readMessages().map(({ message }) => message), userId);
    const authoredIds = new Set(scrubbed.deleted.map((message) => message.id));
    const authoredAttachments = scrubbed.deleted.flatMap((message) => message.attachments ?? []);
    // Deleted messages no longer contain attachments. Unfinished deletion
    // receipts are the durable source for retrying their object cleanup.
    const cleanupReceipts = this.ctx.storage.sql.exec<{ attachments: string }>(
      "SELECT attachments FROM chat_mutation_receipts WHERE actor_id=? AND attachments IS NOT NULL AND cleanup_state<>'complete'", userId,
    ).toArray();
    for (const receipt of cleanupReceipts) authoredAttachments.push(...JSON.parse(receipt.attachments));
    const filesDeleted = await this.deleteOwnedUnreferencedAttachments(
      authoredAttachments,
      userId,
      authoredIds,
      true,
    );

    // Object cleanup yields. Never restore the earlier snapshot over edits or
    // deletions that committed while it was running.
    const latest = scrubDeletedUserFromChat(readMessages().map(({ message }) => message), userId);
    this.ctx.storage.transactionSync(() => {
      for (const message of latest.deleted) {
        this.ctx.storage.sql.exec("DELETE FROM chat_messages WHERE id = ?", message.id);
        this.ctx.storage.sql.exec("DELETE FROM chat_mutation_receipts WHERE json_extract(result,'$.command.messageId')=?", message.id);
      }
      for (const message of latest.messages) this.persistMessage(message);
      this.ctx.storage.sql.exec("DELETE FROM chat_mutation_receipts WHERE actor_id=?", userId);
      this.ctx.storage.sql.exec("DELETE FROM chat_reads WHERE user_id = ?", userId);
    });
    this.recentMessages = latest.messages.slice(-this.HYDRATION_MESSAGE_LIMIT);
    return { messagesDeleted: latest.deleted.length, filesDeleted };
  }

  private async readMemberSession(url: URL): Promise<Extract<ChatSession, { kind: "member" }> | null> {
    if (url.searchParams.get("access") !== "write") return null;
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    if (!userId || !sessionId || url.searchParams.get("userId") !== userId) return null;
    const authClaim = { userId, sessionId, orgId: this.orgId };
    if (!(await hasLivePermissionAuthority(this.env.DB, authClaim, "chat:access"))) return null;
    return {
      kind: "member", userId, authClaim, orgId: this.orgId, roomId: this.roomId,
      name: url.searchParams.get("name") ?? "Member", role: url.searchParams.get("role") ?? undefined,
    };
  }

  private getSession(ws: WebSocket) {
    const session = this.sessions.get(ws) ??
      readChatSession(ws.deserializeAttachment());
    // Older attachments have no authority kind/expiry. Reconnect through the
    // authenticated gateway instead of retaining unverifiable authorization.
    if (!session || session.orgId !== this.orgId || session.roomId !== this.roomId || (session.kind === "guest" && session.expiresAt <= Date.now())) {
      this.sessions.delete(ws);
      try { ws.close(1008, "Chat access expired. Reconnect to continue."); } catch { /* Already closed. */ }
      return null;
    }
    this.sessions.set(ws, session);
    if (!socketReadLeaseAllows(ws, session.kind !== "viewer")) {
      this.sessions.delete(ws);
      return null;
    }
    return session;
  }

  async refreshReadAuthority(userId?: string): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const session = this.getSession(socket);
      if (session?.kind === "guest") {
        if (await chatPassIsRevoked(this.env.DB, session.orgId, session.tokenHash)) {
          socket.close(4403, "Guest pass revoked");
          this.sessions.delete(socket);
          return null;
        }
        return true;
      }
      const claim = socketAuthorityClaim(socket);
      if (!claim || (userId && claim.userId !== userId)) return null;
      return hasLivePermissionAuthority(this.env.DB, claim, "chat:access");
    });
    await scheduleSocketReadRefresh(this.ctx, socket => readChatSession(socket.deserializeAttachment())?.kind !== "viewer",
      await this.ctx.storage.getAlarm());
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
      if (!this.getSession(ws)) continue;
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
