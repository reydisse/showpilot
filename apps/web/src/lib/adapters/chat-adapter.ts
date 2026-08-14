/**
 * Chat Adapter Interface
 *
 * All chat adapters (native, Slack, Mattermost, Teams, Discord)
 * implement this interface. The UI never knows which adapter is active.
 */

export type MessageType = "text" | "alert" | "cue" | "system";
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface ChatAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
}

export interface ChatReplyReference {
  messageId: string;
  senderName: string;
  text: string;
}

export interface ChatMessageOptions {
  replyTo?: ChatReplyReference;
  attachments?: ChatAttachment[];
  mentionedUserIds?: string[];
}

export interface ChatMessage {
  id: string;
  orgId: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: MessageType;
  timestamp: number;
  replyTo?: ChatReplyReference;
  attachments?: ChatAttachment[];
  editedAt?: number;
  deletedAt?: number;
}

export interface ChatTypingState {
  userId?: string;
  name: string;
  typing: boolean;
}

export interface ChatReadReceipt {
  userId: string;
  readAt: number;
}

export interface ChatAdapter {
  /** Send a message through the active chat backend */
  sendMessage(
    text: string,
    type: MessageType,
    senderName: string,
    senderRole?: string,
    options?: ChatMessageOptions,
  ): Promise<void>;

  /** Edit one of the current user's native messages. */
  editMessage?(messageId: string, text: string): Promise<void>;

  /** Soft-delete one of the current user's native messages. */
  deleteMessage?(messageId: string): Promise<void>;

  /** Broadcast ephemeral typing presence for native chat rooms. */
  setTyping?(typing: boolean): void;

  /** Mark a native direct-message conversation read through this timestamp. */
  markRead?(readAt: number): void;

  onTyping?(callback: (state: ChatTypingState) => void): () => void;

  onReadReceipt?(callback: (receipt: ChatReadReceipt) => void): () => void;

  /** Subscribe to incoming messages. Returns a cleanup function. */
  onMessage(callback: (message: ChatMessage) => void): () => void;

  /** Fetch message history from the backend */
  getHistory(limit?: number): Promise<ChatMessage[]>;

  /** Current connection status */
  connectionStatus(): ConnectionStatus;

  /** Establish connection to the chat backend */
  connect(): Promise<void>;

  /** Tear down the connection */
  disconnect(): void;

  /** Subscribe to connection status changes. Returns a cleanup function. */
  onStatusChange?(callback: (status: ConnectionStatus) => void): () => void;
}
