import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  MessageSquare,
  Send,
  AlertTriangle,
  Radio,
  Info,
  ChevronDown,
  X,
  Hash,
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
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
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
  { value: "cue", label: "Cue", icon: <Radio className="w-3 h-3" /> },
  { value: "alert", label: "Alert", icon: <AlertTriangle className="w-3 h-3" /> },
];

function MessageTypeSelector({
  value,
  onChange,
}: {
  value: MessageType;
  onChange: (type: MessageType) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-board-border bg-board-bg/70 p-0.5">
      {MESSAGE_TYPES.map((mt) => (
        <button
          key={mt.value}
          type="button"
          onClick={() => onChange(mt.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition-colors",
            value === mt.value
              ? mt.value === "alert"
                ? "bg-red-500/20 text-red-400"
                : mt.value === "cue"
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-fire-500/15 text-fire-400"
              : "text-board-muted hover:bg-board-border/50 hover:text-board-text",
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

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

const AVATAR_STYLES = [
  "border-sky-400/25 bg-sky-400/10 text-sky-300",
  "border-violet-400/25 bg-violet-400/10 text-violet-300",
  "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  "border-orange-400/25 bg-orange-400/10 text-orange-300",
  "border-pink-400/25 bg-pink-400/10 text-pink-300",
] as const;

function avatarStyle(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) | 0;
  return AVATAR_STYLES[Math.abs(hash) % AVATAR_STYLES.length];
}

function formatDay(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

// -- Single message row --

function ChatMessageRow({
  message,
  isPinned,
  grouped = false,
  isOwn = false,
}: {
  message: ChatMessage;
  isPinned?: boolean;
  grouped?: boolean;
  isOwn?: boolean;
}) {
  const isSystem = message.type === "system";

  if (isSystem) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-[11px] text-board-muted/65">
        <span className="h-px w-6 bg-board-border/70" />
        <Info className="h-3 w-3" />
        <span>{message.text}</span>
        <span className="tabular-nums text-board-muted/40">{formatTimestamp(message.timestamp)}</span>
        <span className="h-px w-6 bg-board-border/70" />
      </div>
    );
  }

  const isEvent = message.type === "cue" || message.type === "alert";

  if (isEvent) {
    return (
      <div className={cn("px-4", grouped ? "pt-1" : "pt-3")}>
        <div className={cn(
          "flex gap-2.5 rounded-lg border px-3 py-2.5 shadow-sm",
          message.type === "alert" ? "border-red-500/25 bg-red-500/[0.08]" : "border-amber-400/20 bg-amber-400/[0.06]",
          isPinned && "ring-1 ring-red-500/35",
        )}>
          <div className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md", message.type === "alert" ? "bg-red-500/15 text-red-300" : "bg-amber-400/15 text-amber-300")}>
            {message.type === "alert" ? <AlertTriangle className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-2">
              <span className={cn("text-[9px] font-bold uppercase tracking-[0.1em]", message.type === "alert" ? "text-red-300" : "text-amber-300")}>{message.type}</span>
              <span className="truncate text-[10px] text-board-muted">{message.senderName}</span>
              <span className="ml-auto shrink-0 text-[9px] tabular-nums text-board-muted/50">{formatTimestamp(message.timestamp)}</span>
            </div>
            <p className={cn("break-words text-[13px] leading-5", message.type === "alert" ? "font-medium text-red-100" : "text-amber-100")}>{message.text}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex px-4",
        isOwn ? "justify-end" : "justify-start",
        grouped ? "pt-1" : "pt-3",
      )}
    >
      {!isOwn && !grouped && (
        <div className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold shadow-sm", avatarStyle(message.senderName))}>
          {initials(message.senderName)}
        </div>
      )}
      {!isOwn && grouped && <span className="w-9 shrink-0" />}
      <div className={cn("min-w-0 max-w-[82%]", !isOwn && "ml-2.5")}>
        {!grouped && (
          <div className={cn("mb-1 flex min-w-0 items-center gap-2", isOwn && "justify-end")}>
            {!isOwn && <span className="truncate text-[12px] font-semibold text-board-text/90">{message.senderName}</span>}
            {!isOwn && <RoleBadge role={message.senderRole} />}
            {isOwn && <span className="text-[10px] font-medium text-board-muted/60">You</span>}
          </div>
        )}
        <div className={cn(
          "relative break-words px-3 py-2 text-[13px] leading-[1.3rem] shadow-sm",
          isOwn ? "rounded-2xl rounded-br-md bg-fire-500 text-black" : "rounded-2xl rounded-bl-md border border-board-border/80 bg-board-bg/75 text-board-text/90",
          grouped && isOwn && "rounded-br-2xl",
          grouped && !isOwn && "rounded-bl-2xl",
        )}>
          <p>{message.text}</p>
          <span className={cn("mt-0.5 block text-right text-[8px] tabular-nums", isOwn ? "text-black/55" : "text-board-muted/45")}>{formatTimestamp(message.timestamp)}</span>
        </div>
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
  currentUserName?: string;
}

export function ChatPanel({
  messages,
  connectionStatus,
  unreadCount,
  onSendMessage,
  onClose,
  className,
  title = "Production Chat",
  subtitle,
  currentUserName,
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
  // Pinning changes prominence, not history. Alerts remain readable in
  // the timeline after their urgent ten-second treatment ends.
  const timelineMessages = messages.filter((m) => !pinnedIds.has(m.id));

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-board-card",
        className,
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-board-border bg-board-bg/25 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-board-border bg-board-bg">
            <Hash className="h-4 w-4 text-board-muted" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-board-text truncate">{title}</span>
              {unreadCount > 0 && <span className="rounded-full bg-fire-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-black">{unreadCount > 99 ? "99+" : unreadCount}</span>}
            </div>
            {subtitle && (
              <p className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-board-muted"><ConnectionDot status={connectionStatus} />{connectionStatus === "connected" ? "Live" : connectionStatus} · {subtitle}</p>
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
        <div className="shrink-0 border-b border-red-500/25 bg-red-500/[0.06] py-1">
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
        className="min-h-0 flex-1 overflow-y-auto py-2 modern-scrollbar"
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

        {timelineMessages.map((msg, index) => {
          const previous = timelineMessages[index - 1];
          const showDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
          const grouped = Boolean(
            previous &&
            previous.type !== "system" &&
            msg.type !== "system" &&
            previous.senderName === msg.senderName &&
            previous.senderRole === msg.senderRole &&
            previous.type === msg.type &&
            msg.timestamp - previous.timestamp < 5 * 60 * 1000,
          );

          return (
            <div key={msg.id}>
              {showDay && (
                <div className="my-2 flex items-center gap-3 px-4" role="separator">
                  <span className="h-px flex-1 bg-board-border/70" />
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted/55">{formatDay(msg.timestamp)}</span>
                  <span className="h-px flex-1 bg-board-border/70" />
                </div>
              )}
              <ChatMessageRow message={msg} grouped={grouped} isOwn={Boolean(currentUserName && msg.senderName === currentUserName)} />
            </div>
          );
        })}
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
      <div className="safe-area-bottom shrink-0 border-t border-board-border bg-board-bg/40 p-3">
        <div className="overflow-hidden rounded-xl border border-board-border/90 bg-board-bg/55 shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition focus-within:border-fire-500/45 focus-within:ring-2 focus-within:ring-fire-500/10">
          <div className="flex items-center justify-between border-b border-board-border/70 px-2 py-1.5">
            <MessageTypeSelector value={messageType} onChange={setMessageType} />
            <span className="hidden text-[10px] text-board-muted/55 sm:block">Enter to send · Shift+Enter for a new line</span>
          </div>
          <div className="flex items-end gap-2 p-2">
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
                  : "Message the production team…"
            }
            rows={1}
            className={cn(
              "flex-1 resize-none bg-transparent px-2 py-2 text-sm text-board-text placeholder:text-board-muted/45 outline-none modern-scrollbar",
              messageType === "cue" && "font-mono",
            )}
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className={cn(
              "mb-0.5 shrink-0 rounded-lg p-2.5 shadow-sm transition-all touch-manipulation",
              inputText.trim()
                ? "bg-fire-500 text-black hover:bg-fire-400"
                : "bg-board-border text-board-muted cursor-not-allowed",
            )}
          >
            <Send className="w-4 h-4" />
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
