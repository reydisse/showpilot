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
  const isSystem = message.type === "system";

  return (
    <div
      className={cn(
        "px-3.5 py-3 rounded-2xl transition-colors shadow-sm",
        message.type === "alert" && "bg-red-500/15 border border-red-500/25",
        message.type === "cue" && "bg-amber-500/10 border border-amber-500/20",
        message.type === "system" && "bg-transparent shadow-none px-1 py-1",
        message.type === "text" && "bg-board-bg/70 border border-board-border/70",
        isPinned && "ring-1 ring-red-500/40",
      )}
    >
      {/* Header: sender + role + time */}
      {!isSystem && (
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-board-text/95">
            {message.senderName}
          </span>
          <RoleBadge role={message.senderRole} />
          <span className="text-[10px] text-board-muted/80 ml-auto shrink-0">
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
  title?: string;
  subtitle?: string;
}

export function ChatPanel({
  messages,
  connectionStatus,
  unreadCount: _unreadCount,
  onSendMessage,
  onClose,
  className,
  title = "Production Chat",
  subtitle,
}: ChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const pinTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedAtRef = useRef(Date.now());

  // Track pinned alerts (pinned for 10 seconds)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  // Pin new alert messages for 10s
  useEffect(() => {
    const latestAlerts = messages.filter(
      (m) =>
        m.type === "alert" &&
        !dismissedAlertIds.has(m.id) &&
        !seenAlertIdsRef.current.has(m.id) &&
        m.timestamp >= mountedAtRef.current - 10000,
    );
    if (latestAlerts.length === 0) return;

    setPinnedIds((prev) => {
      const next = new Set(prev);

      for (const alert of latestAlerts) {
        seenAlertIdsRef.current.add(alert.id);
        next.add(alert.id);

        const existingTimer = pinTimeoutsRef.current.get(alert.id);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          setPinnedIds((current) => {
            const updated = new Set(current);
            updated.delete(alert.id);
            return updated;
          });
          setDismissedAlertIds((current) => {
            const next = new Set(current);
            next.add(alert.id);
            return next;
          });
          pinTimeoutsRef.current.delete(alert.id);
        }, 10000);

        pinTimeoutsRef.current.set(alert.id, timer);
      }

      return next;
    });
  }, [dismissedAlertIds, messages]);

  useEffect(() => {
    return () => {
      for (const timer of pinTimeoutsRef.current.values()) {
        clearTimeout(timer);
      }
      pinTimeoutsRef.current.clear();
    };
  }, []);

  // Keep the latest message visible as messages or pinned alerts change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollButton(false);
  }, [messages.length, pinnedIds.size]);

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

  const dismissAlert = (alertId: string) => {
    const timer = pinTimeoutsRef.current.get(alertId);
    if (timer) {
      clearTimeout(timer);
      pinTimeoutsRef.current.delete(alertId);
    }

    setPinnedIds((current) => {
      const next = new Set(current);
      next.delete(alertId);
      return next;
    });
    setDismissedAlertIds((current) => {
      const next = new Set(current);
      next.add(alertId);
      return next;
    });
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
  const timelineMessages = messages.filter(
    (m) => m.type !== "alert" && !dismissedAlertIds.has(m.id),
  );

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-board-card border-l border-board-border",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-board-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-fire-500/10 border border-fire-500/20 flex items-center justify-center shrink-0">
            <MessageSquare className="w-4 h-4 text-fire-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-board-text truncate">{title}</span>
              <ConnectionDot status={connectionStatus} />
            </div>
            {subtitle && (
              <p className="text-[11px] text-board-muted truncate mt-0.5">{subtitle}</p>
            )}
          </div>
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
        <div className="px-3 py-2.5 space-y-1.5 border-b border-board-border bg-red-500/5 shrink-0">
          {pinnedAlerts.map((alert) => (
            <div key={`pinned-${alert.id}`} className="relative">
              <ChatMessageRow message={alert} isPinned />
              <button
                type="button"
                onClick={() => dismissAlert(alert.id)}
                className="absolute top-2 right-2 rounded-md p-1 text-red-300/70 hover:text-red-100 hover:bg-red-500/10 transition-colors touch-manipulation"
                aria-label="Dismiss alert"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto modern-scrollbar px-3 py-3 space-y-2"
      >
        {timelineMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-board-muted">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">
              {pinnedAlerts.length > 0 ? "Only active alerts are showing right now" : "Production chat will appear here"}
            </p>
          </div>
        )}

        {timelineMessages.map((msg) => (
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
      <div className="px-3 py-2 border-t border-board-border shrink-0 space-y-2 safe-area-bottom">
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
              "shrink-0 p-2 rounded-lg transition-colors touch-manipulation",
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
