import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage, ConnectionStatus } from "@/lib/adapters/chat-adapter";

interface ChatCompactProps {
  messages: ChatMessage[];
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  onClick?: () => void;
  className?: string;
}

/**
 * ChatCompact -- inline header preview of the last 3 chat messages
 * with an unread badge. Click to expand the full ChatPanel.
 */
export function ChatCompact({
  messages,
  connectionStatus,
  unreadCount,
  onClick,
  className,
}: ChatCompactProps) {
  const lastThree = messages.slice(-3);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg",
        "bg-board-card border border-board-border",
        "hover:bg-board-border/50 transition-colors",
        "text-left max-w-md",
        className,
      )}
    >
      {/* Icon with unread badge */}
      <div className="relative shrink-0">
        <MessageSquare className="w-4 h-4 text-board-muted" />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 flex items-center justify-center px-1 rounded-full bg-fire-500 text-white text-[10px] font-bold leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </div>

      {/* Last 3 messages preview */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {lastThree.length === 0 ? (
          <span className="text-xs text-board-muted">No messages</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {lastThree.map((msg) => (
              <div key={msg.id} className="flex items-baseline gap-1 truncate">
                <span
                  className={cn(
                    "text-[10px] font-semibold shrink-0",
                    msg.type === "alert" && "text-red-400",
                    msg.type === "cue" && "text-amber-400",
                    msg.type === "system" && "text-board-muted",
                    msg.type === "text" && "text-board-text",
                  )}
                >
                  {msg.type === "system" ? "SYS" : msg.senderName}:
                </span>
                <span
                  className={cn(
                    "text-[10px] truncate",
                    msg.type === "alert" && "text-red-300",
                    msg.type === "cue" && "text-amber-300 font-mono",
                    msg.type === "system" && "text-board-muted italic",
                    msg.type === "text" && "text-board-muted",
                  )}
                >
                  {msg.type === "cue" ? `[CUE] ${msg.text}` : msg.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Connection status dot */}
      <span
        title={`Chat: ${connectionStatus}`}
        className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          connectionStatus === "connected" && "bg-green-500",
          connectionStatus === "connecting" && "bg-yellow-500 animate-pulse",
          connectionStatus === "disconnected" && "bg-gray-500",
          connectionStatus === "error" && "bg-red-500",
        )}
      />
    </button>
  );
}
