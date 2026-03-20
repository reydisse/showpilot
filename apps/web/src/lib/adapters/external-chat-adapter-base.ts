/**
 * Base class for external chat adapters (Mattermost, Slack, Discord, Teams).
 *
 * Handles the polling loop, message deduplication, status tracking, and
 * listener management. Concrete adapters only need to provide their platform name.
 * All actual API calls go through server functions in chat-proxy.ts.
 */

import type {
  ChatAdapter,
  ChatMessage,
  ConnectionStatus,
  MessageType,
} from "./chat-adapter";
import {
  testChatConnection,
  sendExternalChatMessage,
  getExternalChatHistory,
} from "@/lib/chat-proxy";

const POLL_INTERVAL = 3000; // 3 seconds
const MAX_CONSECUTIVE_ERRORS = 3;

export class ExternalChatAdapterBase implements ChatAdapter {
  protected orgId: string;
  protected platform: "mattermost" | "slack" | "teams" | "discord";
  protected status: ConnectionStatus = "disconnected";
  protected listeners = new Set<(msg: ChatMessage) => void>();
  protected statusListeners = new Set<(status: ConnectionStatus) => void>();
  protected messages: ChatMessage[] = [];
  protected seenIds = new Set<string>();
  protected pollTimer: ReturnType<typeof setInterval> | null = null;
  protected lastPollTimestamp: string | undefined;
  protected consecutiveErrors = 0;
  protected sendOnly: boolean;

  constructor(
    orgId: string,
    platform: "mattermost" | "slack" | "teams" | "discord",
    options?: { sendOnly?: boolean },
  ) {
    this.orgId = orgId;
    this.platform = platform;
    this.sendOnly = options?.sendOnly ?? false;
  }

  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;
    this.setStatus("connecting");

    try {
      // Validate credentials
      const result = await testChatConnection({
        data: { orgId: this.orgId, platform: this.platform },
      });

      if (!result.ok) {
        this.setStatus("error");
        return;
      }

      this.setStatus("connected");
      this.consecutiveErrors = 0;

      // Fetch initial history
      if (!this.sendOnly) {
        try {
          const history = await getExternalChatHistory({
            data: { orgId: this.orgId, platform: this.platform, limit: 50 },
          });
          if (history.ok && history.messages.length > 0) {
            for (const msg of history.messages) {
              if (!this.seenIds.has(msg.id)) {
                this.seenIds.add(msg.id);
                this.messages.push(msg);
                this.notifyListeners(msg);
              }
            }
            // Set poll token to latest message timestamp
            const latest = history.messages[history.messages.length - 1];
            this.lastPollTimestamp = String(latest.timestamp);
          }
        } catch {
          // Non-fatal — continue without history
        }
        this.startPolling();
      }
    } catch {
      this.setStatus("error");
    }
  }

  disconnect(): void {
    this.stopPolling();
    this.setStatus("disconnected");
    this.messages = [];
    this.seenIds.clear();
    this.lastPollTimestamp = undefined;
    this.consecutiveErrors = 0;
  }

  async sendMessage(
    text: string,
    type: MessageType,
    senderName: string,
    _senderRole?: string,
  ): Promise<void> {
    try {
      await sendExternalChatMessage({
        data: {
          orgId: this.orgId,
          platform: this.platform,
          text,
          senderName,
          type,
        },
      });
    } catch {
      // Silent failure per spec — operator UI stays clean
    }
  }

  onMessage(callback: (message: ChatMessage) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  async getHistory(limit?: number): Promise<ChatMessage[]> {
    const history = [...this.messages];
    if (limit && limit > 0) return history.slice(-limit);
    return history;
  }

  connectionStatus(): ConnectionStatus {
    return this.status;
  }

  // ─── Private ──────────────────────────────────────────────

  protected setStatus(status: ConnectionStatus) {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Don't let listener errors break the adapter
      }
    }
  }

  protected notifyListeners(message: ChatMessage) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // Don't let listener errors break the adapter
      }
    }
  }

  protected startPolling() {
    if (this.pollTimer || this.sendOnly) return;

    this.pollTimer = setInterval(async () => {
      try {
        const result = await getExternalChatHistory({
          data: {
            orgId: this.orgId,
            platform: this.platform,
            limit: 20,
            since: this.lastPollTimestamp,
          },
        });

        if (result.ok) {
          this.consecutiveErrors = 0;
          for (const msg of result.messages) {
            if (!this.seenIds.has(msg.id)) {
              this.seenIds.add(msg.id);
              this.messages.push(msg);
              this.notifyListeners(msg);
            }
          }
          // Update poll token
          if (result.messages.length > 0) {
            const latest = result.messages[result.messages.length - 1];
            this.lastPollTimestamp = String(latest.timestamp);
          }
        } else {
          this.consecutiveErrors++;
        }
      } catch {
        this.consecutiveErrors++;
      }

      // After too many consecutive errors, stop polling and show error
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.stopPolling();
        this.setStatus("error");
      }
    }, POLL_INTERVAL);
  }

  protected stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
