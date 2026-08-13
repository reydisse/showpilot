import type {
  ChatAdapter,
  ChatMessage,
  ChatMessageOptions,
  ConnectionStatus,
  MessageType,
} from "./chat-adapter";

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
  private messageQueue: QueuedMessage[] = [];
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private messageHistory: ChatMessage[] = [];

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
            } else if ((data.type === "message" || data.type === "message-edited" || data.type === "message-deleted") && data.message) {
              const existingIndex = this.messageHistory.findIndex((message) => message.id === data.message.id);
              if (existingIndex >= 0) this.messageHistory[existingIndex] = data.message;
              else this.messageHistory.push(data.message);
              this.notifyListeners(data.message);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !text.trim()) return;
    this.ws.send(JSON.stringify({ type: "edit", messageId, text: text.trim() }));
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "delete", messageId }));
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
