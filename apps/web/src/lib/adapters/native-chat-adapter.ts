import type {
  ChatAdapter,
  ChatMessage,
  ChatMessageOptions,
  ChatReadReceipt,
  ChatTypingState,
  ConnectionStatus,
  MessageType,
} from "./chat-adapter";
import { createBrowserId } from "@/lib/browser-id";

/**
 * Native Chat Adapter
 *
 * Connects to the ChatRelay Durable Object via WebSocket.
 * Used when no external chat integration (Slack, Mattermost, etc.) is configured.
 *
 * Features:
 * - Exponential backoff reconnection
 * - Outgoing message queue during disconnection
 * - Automatic queue flush on reconnect
 */

interface QueuedMessage {
  text: string;
  type: MessageType;
  senderName: string;
  senderRole?: string;
  options?: ChatMessageOptions;
}

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
  private messageQueue: QueuedMessage[] = [];
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private messageHistory: ChatMessage[] = [];
  private pendingMutations = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(orgId: string, private guest?: { token: string; name: string }, private roomId = "production") {
    this.orgId = orgId;
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
                this.notifyListeners(msg);
              }
              if (data.readReceipts && typeof data.readReceipts === "object") {
                for (const [userId, readAt] of Object.entries(data.readReceipts)) {
                  if (typeof readAt === "number") this.notifyReadReceipt({ userId, readAt });
                }
              }
            } else if ((data.type === "message" || data.type === "message-edited" || data.type === "message-deleted") && data.message) {
              const existingIndex = this.messageHistory.findIndex((message) => message.id === data.message.id);
              if (existingIndex >= 0) this.messageHistory[existingIndex] = data.message;
              else this.messageHistory.push(data.message);
              this.notifyListeners(data.message);
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
            }
          } catch {
            // Ignore malformed messages
          }
        };

        this.ws.onclose = () => {
          this.ws = null;
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
    const payload = { text, type: this.guest ? "text" as const : type, senderName, senderRole, options };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "identify",
        name: payload.senderName,
        role: payload.senderRole,
      }));
      // ChatRelay expects: { type: "message", text, messageType, name, role }
      this.ws.send(JSON.stringify({
        type: "message",
        orgId: this.orgId,
        text: payload.text,
        messageType: payload.type,
        name: payload.senderName,
        role: payload.senderRole,
        replyTo: payload.options?.replyTo,
        attachments: payload.options?.attachments,
        poll: payload.options?.poll,
        clientMessageId: payload.options?.clientMessageId,
      }));
    } else {
      // Queue the message for when we reconnect
      this.messageQueue.push(payload);
    }
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

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      this.ws.send(
        JSON.stringify({
          type: "identify",
          name: msg.senderName,
          role: msg.senderRole,
        }),
      );
      this.ws.send(
        JSON.stringify({
          type: "message",
          orgId: this.orgId,
          text: msg.text,
          messageType: msg.type,
          name: msg.senderName,
          role: msg.senderRole,
          replyTo: msg.options?.replyTo,
          attachments: msg.options?.attachments,
          poll: msg.options?.poll,
          clientMessageId: msg.options?.clientMessageId,
        }),
      );
    }
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
