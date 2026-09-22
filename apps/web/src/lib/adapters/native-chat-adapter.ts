import type {
  ChatAdapter,
  ChatMessage,
  ChatMessageOptions,
  ChatReadReceipt,
  ChatHydrationState,
  ChatGatewayStatus,
  ChatTypingState,
  ConnectionStatus,
  MessageType,
} from "./chat-adapter";
import { createBrowserId } from "@/lib/browser-id";
import { readChatOutbox, writeChatOutbox, type ChatOutboxItem } from "@/lib/chat-outbox";

/**
 * Native Chat Adapter
 *
 * Connects to the ChatRelay Durable Object via WebSocket.
 * This is the canonical client transport even when an external gateway is
 * configured. The relay mirrors the shared conversation to that gateway.
 *
 * Features:
 * - Exponential backoff reconnection
 * - Outgoing message queue during disconnection
 * - Automatic queue flush on reconnect
 */

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const BACKOFF_MULTIPLIER = 2;

export class NativeChatAdapter implements ChatAdapter {
  private orgId: string;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private listeners: Set<(message: ChatMessage) => void> = new Set();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private typingListeners = new Set<(state: ChatTypingState) => void>();
  private readReceiptListeners = new Set<(receipt: ChatReadReceipt) => void>();
  private hydrationListeners = new Set<(state: ChatHydrationState) => void>();
  private gatewayStatusListeners = new Set<(status: ChatGatewayStatus) => void>();
  private gatewayStatus: ChatGatewayStatus | null = null;
  private messageQueue: ChatOutboxItem[] = [];
  private outboxListeners = new Set<(messages: ChatMessage[]) => void>();
  private historyCursor: { timestamp: number; id: string } | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private messageHistory: ChatMessage[] = [];
  private pendingMutations = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(orgId: string, private guest?: { token: string; name: string }, private roomId = "production", private outboxIdentity = "unscoped", private currentUserId?: string) {
    this.orgId = orgId;
    this.messageQueue = readChatOutbox(this.outboxIdentity, this.orgId, this.roomId);
  }

  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    this.intentionalClose = false;
    this.setStatus("connecting");

    return new Promise<void>((resolve, reject) => {
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const params = new URLSearchParams({ room: this.roomId });
        if (this.guest) {
          params.set("guestToken", this.guest.token);
          params.set("guestName", this.guest.name);
        }
        const wsUrl = `${protocol}//${window.location.host}/api/chat/${this.orgId}/ws?${params}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          this.setStatus("connected");
          this.reconnectDelay = INITIAL_RECONNECT_DELAY;
          this.flushQueue();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if ((data.type === "hydrate" || data.type === "history") && Array.isArray(data.messages)) {
              // Initial history hydration from the ChatRelay Durable Object
              this.messageHistory = data.messages;
              for (const msg of data.messages) {
                this.acknowledgeQueued(msg.id);
                this.notifyListeners(msg);
              }
              const oldest = data.messages[0];
              this.historyCursor = oldest && typeof oldest.timestamp === "number" && typeof oldest.id === "string" ? { timestamp: oldest.timestamp, id: oldest.id } : null;
              const readReceipts: Record<string, number> = {};
              if (data.readReceipts && typeof data.readReceipts === "object") {
                for (const [userId, readAt] of Object.entries(data.readReceipts)) {
                  if (typeof readAt === "number") readReceipts[userId] = readAt;
                  if (typeof readAt === "number") this.notifyReadReceipt({ userId, readAt });
                }
              }
              for (const listener of this.hydrationListeners) listener({ readReceipts });
            } else if ((data.type === "message" || data.type === "message-edited" || data.type === "message-deleted") && data.message) {
              this.acknowledgeQueued(data.message.id);
              const existingIndex = this.messageHistory.findIndex((message) => message.id === data.message.id);
              if (existingIndex >= 0) this.messageHistory[existingIndex] = data.message;
              else this.messageHistory.push(data.message);
              this.notifyListeners(data.message);
            } else if (data.type === "error" && typeof data.messageId === "string") {
              this.updateQueued(data.messageId, { status: "failed", error: typeof data.error === "string" ? data.error : "Message was not accepted" });
            } else if (data.type === "mutation-result" && data.requestId) {
              const pending = this.pendingMutations.get(data.requestId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingMutations.delete(data.requestId);
                if (data.ok) pending.resolve();
                else pending.reject(new Error(data.error || "Message update failed"));
              }
            } else if (data.type === "typing" && typeof data.name === "string" && typeof data.typing === "boolean") {
              this.notifyTyping({ userId: typeof data.userId === "string" ? data.userId : undefined, name: data.name, typing: data.typing });
            } else if (data.type === "read-receipt" && typeof data.userId === "string" && typeof data.readAt === "number") {
              this.notifyReadReceipt({ userId: data.userId, readAt: data.readAt });
            } else if (data.type === "gateway-status"
              && (data.platform === null || data.platform === "mattermost" || data.platform === "slack" || data.platform === "discord" || data.platform === "teams")
              && (data.status === "disabled" || data.status === "connecting" || data.status === "connected" || data.status === "error")) {
              this.notifyGatewayStatus({
                platform: data.platform,
                status: data.status,
                ...(typeof data.error === "string" ? { error: data.error } : {}),
              });
            }
          } catch {
            // Ignore malformed messages
          }
        };

        this.ws.onclose = () => {
          this.ws = null;
          this.messageQueue = this.messageQueue.map((item) => item.status === "sending" ? { ...item, status: "waiting" } : item);
          this.persistAndNotifyOutbox();
          this.setStatus("disconnected");
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = () => {
          this.setStatus("error");
          reject(new Error("WebSocket connection failed"));
        };
      } catch (err) {
        this.setStatus("error");
        reject(err);
      }
    });
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message cannot be empty");
    return this.sendMutation({ type: "edit", messageId, text: text.trim() });
  }

  async deleteMessage(messageId: string): Promise<void> {
    return this.sendMutation({ type: "delete", messageId });
  }

  async votePoll(messageId: string, optionId: string): Promise<void> {
    return this.sendMutation({ type: "vote", messageId, optionId });
  }

  async toggleReaction(messageId: string, emoji: string): Promise<void> {
    return this.sendMutation({ type: "reaction", messageId, emoji });
  }

  setTyping(typing: boolean): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "typing", typing }));
  }

  markRead(readAt: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "read", readAt }));
  }

  onTyping(callback: (state: ChatTypingState) => void): () => void {
    this.typingListeners.add(callback);
    return () => this.typingListeners.delete(callback);
  }

  onReadReceipt(callback: (receipt: ChatReadReceipt) => void): () => void {
    this.readReceiptListeners.add(callback);
    return () => this.readReceiptListeners.delete(callback);
  }

  onHydrated(callback: (state: ChatHydrationState) => void): () => void {
    this.hydrationListeners.add(callback);
    return () => this.hydrationListeners.delete(callback);
  }

  onGatewayStatus(callback: (status: ChatGatewayStatus) => void): () => void {
    this.gatewayStatusListeners.add(callback);
    if (this.gatewayStatus) callback(this.gatewayStatus);
    return () => this.gatewayStatusListeners.delete(callback);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
    this.messageQueue = this.messageQueue.map((item) => item.status === "sending" ? { ...item, status: "waiting" } : item);
    this.persistAndNotifyOutbox();
    for (const pending of this.pendingMutations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chat disconnected before the update completed"));
    }
    this.pendingMutations.clear();
  }

  async sendMessage(
    text: string,
    type: MessageType,
    senderName: string,
    senderRole?: string,
    options?: ChatMessageOptions,
  ): Promise<void> {
    const id = options?.clientMessageId ?? createBrowserId();
    const payload: ChatOutboxItem = { id, orgId: this.orgId, roomId: this.roomId, ...(this.currentUserId ? { senderId: this.currentUserId } : {}), text, type: this.guest ? "text" : type, senderName, ...(senderRole ? { senderRole } : {}), options: { ...options, clientMessageId: id }, createdAt: Date.now(), status: "waiting" };
    if (!this.messageQueue.some((item) => item.id === id)) this.messageQueue.push(payload);
    this.persistAndNotifyOutbox();
    if (this.ws?.readyState === WebSocket.OPEN) this.sendQueued(payload);
  }

  onMessage(callback: (message: ChatMessage) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Subscribe to connection status changes. Returns cleanup function. */
  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  async getHistory(limit?: number): Promise<ChatMessage[]> {
    const history = [...this.messageHistory];
    if (limit && limit > 0) {
      return history.slice(-limit);
    }
    return history;
  }

  async loadOlder(limit = 100): Promise<{ messages: ChatMessage[]; nextCursor: { timestamp: number; id: string } | null }> {
    if (!this.historyCursor) return { messages: [], nextCursor: null };
    const params = new URLSearchParams({ room: this.roomId, limit: String(Math.max(1, Math.min(limit, 200))), beforeTimestamp: String(this.historyCursor.timestamp), beforeId: this.historyCursor.id });
    if (this.guest) { params.set("guestToken", this.guest.token); params.set("guestName", this.guest.name); }
    const response = await fetch(`/api/chat/${encodeURIComponent(this.orgId)}/history?${params}`);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "You no longer have access to this conversation." : "Older messages could not be loaded.");
    const value: unknown = await response.json();
    const body = value && typeof value === "object" ? value as { messages?: unknown; nextCursor?: unknown } : {};
    const messages = Array.isArray(body.messages) ? body.messages.filter((message): message is ChatMessage => Boolean(message) && typeof message === "object" && typeof (message as ChatMessage).id === "string" && typeof (message as ChatMessage).timestamp === "number") : [];
    const cursor = body.nextCursor && typeof body.nextCursor === "object" && typeof (body.nextCursor as { timestamp?: unknown }).timestamp === "number" && typeof (body.nextCursor as { id?: unknown }).id === "string" ? body.nextCursor as { timestamp: number; id: string } : null;
    this.historyCursor = cursor;
    const byId = new Map([...messages, ...this.messageHistory].map((message) => [message.id, message]));
    this.messageHistory = [...byId.values()].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    return { messages, nextCursor: cursor };
  }

  onOutboxChange(callback: (messages: ChatMessage[]) => void): () => void {
    this.outboxListeners.add(callback);
    callback(this.outboxMessages());
    return () => this.outboxListeners.delete(callback);
  }

  retryOutbox(messageId: string): void {
    const item = this.messageQueue.find((candidate) => candidate.id === messageId);
    if (!item) return;
    this.updateQueued(messageId, { status: "waiting", error: undefined });
    if (this.ws?.readyState === WebSocket.OPEN) this.sendQueued({ ...item, status: "waiting", error: undefined });
  }

  cancelOutbox(messageId: string): void {
    this.messageQueue = this.messageQueue.filter((item) => item.id !== messageId);
    this.persistAndNotifyOutbox();
  }

  connectionStatus(): ConnectionStatus {
    return this.status;
  }

  // -- Private helpers --

  private sendMutation(payload: { type: "edit" | "delete" | "vote" | "reaction"; messageId: string; text?: string; optionId?: string; emoji?: string }): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat is offline. Reconnect and try again."));
    const requestId = createBrowserId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMutations.delete(requestId);
        reject(new Error("The message update timed out. Please try again."));
      }, 8000);
      this.pendingMutations.set(requestId, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ ...payload, requestId }));
    });
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Don't let listener errors break the adapter
      }
    }
  }

  private notifyListeners(message: ChatMessage) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // Don't let listener errors break the adapter
      }
    }
  }

  private notifyTyping(state: ChatTypingState) {
    for (const listener of this.typingListeners) listener(state);
  }

  private notifyReadReceipt(receipt: ChatReadReceipt) {
    for (const listener of this.readReceiptListeners) listener(receipt);
  }

  private notifyGatewayStatus(status: ChatGatewayStatus) {
    if (this.gatewayStatus
      && this.gatewayStatus.platform === status.platform
      && this.gatewayStatus.status === status.status
      && this.gatewayStatus.error === status.error) return;
    this.gatewayStatus = status;
    for (const listener of this.gatewayStatusListeners) listener(status);
  }

  private outboxMessages(): ChatMessage[] {
    return this.messageQueue.map((item) => ({ id: item.id, orgId: item.orgId, ...(item.senderId ? { senderId: item.senderId } : {}), senderName: item.senderName, ...(item.senderRole ? { senderRole: item.senderRole } : {}), text: item.text, type: item.type, timestamp: item.createdAt, ...(item.options?.replyTo ? { replyTo: item.options.replyTo } : {}), ...(item.options?.attachments ? { attachments: item.options.attachments } : {}), ...(item.options?.poll ? { poll: item.options.poll } : {}), delivery: item.status, ...(item.error ? { deliveryError: item.error } : {}) }));
  }

  private persistAndNotifyOutbox() {
    writeChatOutbox(this.outboxIdentity, this.orgId, this.roomId, this.messageQueue);
    const messages = this.outboxMessages();
    for (const listener of this.outboxListeners) listener(messages);
  }

  private updateQueued(id: string, update: Pick<ChatOutboxItem, "status"> & { error?: string }) {
    this.messageQueue = this.messageQueue.map((item) => item.id === id ? { ...item, ...update } : item);
    this.persistAndNotifyOutbox();
  }

  private acknowledgeQueued(id: string) {
    if (!this.messageQueue.some((item) => item.id === id)) return;
    this.messageQueue = this.messageQueue.filter((item) => item.id !== id);
    this.persistAndNotifyOutbox();
  }

  private sendQueued(item: ChatOutboxItem) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || item.status === "failed") return;
    this.updateQueued(item.id, { status: "sending", error: undefined });
    this.ws.send(JSON.stringify({ type: "identify", name: item.senderName, role: item.senderRole }));
    this.ws.send(JSON.stringify({ type: "message", orgId: this.orgId, text: item.text, messageType: item.type, name: item.senderName, role: item.senderRole, replyTo: item.options?.replyTo, attachments: item.options?.attachments, poll: item.options?.poll, clientMessageId: item.id }));
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const message of this.messageQueue) this.sendQueued(message);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    // Increase delay for next attempt (backoff before scheduling)
    this.reconnectDelay = Math.min(
      this.reconnectDelay * BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // connect() will schedule another reconnect via onclose
      });
    }, delay);
  }
}
