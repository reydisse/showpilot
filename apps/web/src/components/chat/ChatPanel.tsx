import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  MessageSquare,
  Send,
  AlertTriangle,
  Radio,
  Info,
  ChevronDown,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import { getDepartment, DEPARTMENTS } from "@/types";

// -- Role badge component --

function RoleBadge({ role }: { role?: string }) {
  if (!role) return null;

  const dept = getDepartment(role);
  const config = DEPARTMENTS[dept];

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border",
        config.color,
      )}
    >
      {role}
    </span>
  );
}

// -- Message type selector --

const MESSAGE_TYPES: { value: MessageType; label: string; icon: React.ReactNode }[] = [
  { value: "text", label: "Text", icon: <MessageSquare className="w-3 h-3" /> },
  { value: "alert", label: "Alert", icon: <AlertTriangle className="w-3 h-3" /> },
  { value: "cue", label: "Cue", icon: <Radio className="w-3 h-3" /> },
  { value: "system", label: "System", icon: <Info className="w-3 h-3" /> },
];

function MessageTypeSelector({
  value,
  onChange,
}: {
  value: MessageType;
  onChange: (type: MessageType) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {MESSAGE_TYPES.map((mt) => (
        <button
          key={mt.value}
          type="button"
          onClick={() => onChange(mt.value)}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium uppercase tracking-wide transition-colors",
            value === mt.value
              ? mt.value === "alert"
                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                : mt.value === "cue"
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                  : mt.value === "system"
                    ? "bg-board-border text-board-muted border border-board-border"
                    : "bg-fire-500/20 text-fire-400 border border-fire-500/30"
              : "text-board-muted hover:text-board-text hover:bg-board-border/50 border border-transparent",
          )}
        >
          {mt.icon}
          {mt.label}
        </button>
      ))}
    </div>
  );
}

// -- Connection status dot --

function ConnectionDot({ status }: { status: ConnectionStatus }) {
  return (
    <span
      title={`Chat: ${status}`}
      className={cn(
        "w-2 h-2 rounded-full shrink-0 transition-colors",
        status === "connected" && "bg-green-500",
        status === "connecting" && "bg-yellow-500 animate-pulse",
        status === "disconnected" && "bg-gray-500",
        status === "error" && "bg-red-500",
      )}
    />
  );
}

// -- Timestamp formatter --

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// -- Single message row --

function ChatMessageRow({
  message,
  isPinned,
}: {
  message: ChatMessage;
  isPinned?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-3 py-2 rounded-lg transition-colors",
        message.type === "alert" && "bg-red-500/15 border border-red-500/25",
        message.type === "cue" && "bg-amber-500/10 border border-amber-500/20",
        message.type === "system" && "bg-transparent",
        message.type === "text" && "bg-transparent",
        isPinned && "ring-1 ring-red-500/40",
      )}
    >
      {/* Header: sender + role + time */}
      {message.type !== "system" && (
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-semibold text-board-text">
            {message.senderName}
          </span>
          <RoleBadge role={message.senderRole} />
          <span className="text-[10px] text-board-muted ml-auto shrink-0">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      )}

      {/* Message body */}
      <div
        className={cn(
          "text-sm leading-relaxed break-words",
          message.type === "text" && "text-board-text",
          message.type === "alert" && "text-red-300 font-medium",
          message.type === "cue" && "text-amber-300 font-mono",
          message.type === "system" && "text-board-muted text-xs italic",
        )}
      >
        {message.type === "cue" && (
          <span className="text-amber-400 font-bold mr-1">[CUE]</span>
        )}
        {message.type === "system" && (
          <span className="text-[10px] text-board-muted mr-2">
            {formatTimestamp(message.timestamp)}
          </span>
        )}
        {message.text}
      </div>
    </div>
  );
}

// -- Main ChatPanel --

interface ChatPanelProps {
  messages: ChatMessage[];
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  onSendMessage: (text: string, type: MessageType) => void;
  onClose?: () => void;
  className?: string;
}

export function ChatPanel({
  messages,
  connectionStatus,
  unreadCount: _unreadCount,
  onSendMessage,
  onClose,
  className,
}: ChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Track pinned alerts (pinned for 10 seconds)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  // Pin new alert messages for 10s
  useEffect(() => {
    const latestAlerts = messages.filter(
      (m) => m.type === "alert" && !pinnedIds.has(m.id),
    );
    if (latestAlerts.length === 0) return;

    const newPinned = new Set(pinnedIds);
    for (const alert of latestAlerts) {
      newPinned.add(alert.id);
    }
    setPinnedIds(newPinned);

    const timer = setTimeout(() => {
      setPinnedIds((prev) => {
        const next = new Set(prev);
        for (const alert of latestAlerts) {
          next.delete(alert.id);
        }
        return next;
      });
    }, 10000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (!showScrollButton) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, showScrollButton]);

  // Detect if user has scrolled up
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    setShowScrollButton(!isAtBottom);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollButton(false);
  };

  const handleSend = () => {
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim(), messageType);
    setInputText("");
    setMessageType("text");

    // Re-focus textarea
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText]);

  // Separate pinned alerts from regular messages
  const pinnedAlerts = messages.filter((m) => pinnedIds.has(m.id));

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-board-card border-l border-board-border",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-board-border shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-fire-400" />
          <span className="text-sm font-semibold text-board-text">Production Chat</span>
          <ConnectionDot status={connectionStatus} />
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-board-muted hover:text-board-text transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Pinned alerts */}
      {pinnedAlerts.length > 0 && (
        <div className="px-3 py-2 space-y-1 border-b border-board-border bg-red-500/5 shrink-0">
          {pinnedAlerts.map((alert) => (
            <ChatMessageRow key={`pinned-${alert.id}`} message={alert} isPinned />
          ))}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto modern-scrollbar px-3 py-2 space-y-1"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-board-muted">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">Production chat will appear here</p>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessageRow key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-board-border/90 text-board-text text-xs font-medium shadow-lg hover:bg-board-border transition-colors backdrop-blur-sm"
          >
            <ChevronDown className="w-3 h-3" />
            New messages
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="px-3 py-2 border-t border-board-border shrink-0 space-y-2">
        <MessageTypeSelector value={messageType} onChange={setMessageType} />
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              messageType === "cue"
                ? "Camera 2 wide..."
                : messageType === "alert"
                  ? "Alert message..."
                  : "Type a message..."
            }
            rows={1}
            className={cn(
              "flex-1 resize-none rounded-lg px-3 py-2 text-sm text-board-text placeholder:text-board-muted/50 outline-none transition-all modern-scrollbar",
              "bg-board-bg border border-board-border",
              "focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20",
              messageType === "cue" && "font-mono",
            )}
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className={cn(
              "shrink-0 p-2 rounded-lg transition-colors",
              inputText.trim()
                ? "bg-fire-500 text-white hover:bg-fire-600"
                : "bg-board-border text-board-muted cursor-not-allowed",
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
