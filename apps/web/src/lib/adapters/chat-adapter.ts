/**
 * Chat Adapter Interface
 *
 * All chat adapters (native, Slack, Mattermost, Teams, Discord)
 * implement this interface. The UI never knows which adapter is active.
 */

export type MessageType = "text" | "alert" | "cue" | "system";
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface ChatMessage {
  id: string;
  orgId: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: MessageType;
  timestamp: number;
}

export interface ChatAdapter {
  /** Send a message through the active chat backend */
  sendMessage(
    text: string,
    type: MessageType,
    senderName: string,
    senderRole?: string,
  ): Promise<void>;

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
