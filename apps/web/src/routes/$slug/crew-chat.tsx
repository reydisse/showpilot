import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  MessageSquare,
  AlertCircle,
  Radio,
  Terminal,
  ArrowLeft,
  Send,
  Bell,
  BellOff,
} from "lucide-react";
import { getChatMessages, sendChatMessage } from "@/lib/chat";
import { requestNotificationPermission } from "@/lib/notifications";

type MessageType = "text" | "alert" | "cue" | "system";

const MESSAGE_STYLES: Record<
  MessageType,
  { bg: string; text: string; label: string; icon: React.ElementType }
> = {
  text: { bg: "", text: "text-board-text/90", label: "Message", icon: MessageSquare },
  alert: { bg: "bg-red-500/10 border-red-500/30", text: "text-red-300", label: "Alert", icon: AlertCircle },
  cue: { bg: "bg-amber-500/10 border-amber-500/30", text: "text-amber-300 font-mono", label: "Cue", icon: Radio },
  system: { bg: "bg-board-border/30", text: "text-board-muted italic", label: "System", icon: Terminal },
};

export const Route = createFileRoute("/$slug/crew-chat")({
  validateSearch: (search: Record<string, unknown>) => ({
    name: (search.name as string) || "",
  }),
  loader: async ({ context }) => {
    const messages = await getChatMessages({ data: { orgId: context.orgId, limit: 100 } });
    return { messages, orgId: context.orgId, slug: context.slug };
  },
  component: CrewChatPage,
});

function timeAgo(timestamp: string | Date): string {
  const ms = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp.getTime();
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function CrewChatPage() {
  const { messages: initialMessages, orgId, slug } = Route.useLoaderData();
  const { name: searchName } = Route.useSearch();

  // Sender name: prefer search param (from check-in), then localStorage
  const [senderName, setSenderName] = useState(() => {
    if (searchName) return searchName;
    if (typeof window !== "undefined") {
      return localStorage.getItem("showpilot-chat-name") ?? "";
    }
    return "";
  });
  const [showNameInput, setShowNameInput] = useState(!senderName);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [msgType, setMsgType] = useState<MessageType>("text");
  const [sending, setSending] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persist name from search param
  useEffect(() => {
    if (searchName && typeof window !== "undefined") {
      localStorage.setItem("showpilot-chat-name", searchName);
    }
  }, [searchName]);

  // Check notification permission
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  // Poll for new messages every 3 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const fresh = await getChatMessages({ data: { orgId, limit: 100 } });
        setMessages(fresh);
      } catch {
        // Silently retry next interval
      }
    };

    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [orgId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSetName = useCallback(() => {
    if (!senderName.trim()) return;
    localStorage.setItem("showpilot-chat-name", senderName.trim());
    setShowNameInput(false);
  }, [senderName]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !senderName.trim()) return;
    setSending(true);
    try {
      const text = msgType === "cue" ? `[CUE] ${input.trim()}` : input.trim();
      await sendChatMessage({ data: { orgId, message: text, senderName: senderName.trim() } });
      setInput("");
      const fresh = await getChatMessages({ data: { orgId, limit: 100 } });
      setMessages(fresh);
    } catch {
      // Keep last state
    } finally {
      setSending(false);
    }
  }, [input, senderName, msgType, orgId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNotificationToggle = async () => {
    const result = await requestNotificationPermission();
    setNotifPermission(result);
  };

  const sortedMessages = [...messages].reverse();

  return (
    <div className="h-[100dvh] flex flex-col bg-board-bg">
      {/* Header */}
      <div className="shrink-0 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 py-3 safe-area-top">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to={`/${slug}/checkin`}
              className="p-2 -ml-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-base font-semibold text-board-text">
                Production Chat
              </h1>
              <p className="text-[11px] text-board-muted">
                {senderName && !showNameInput ? `Signed in as ${senderName}` : "Team communication"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Notification toggle */}
            <button
              onClick={handleNotificationToggle}
              className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
              title={notifPermission === "granted" ? "Notifications on" : "Enable notifications"}
            >
              {notifPermission === "granted" ? (
                <Bell className="w-5 h-5 text-fire-500" />
              ) : (
                <BellOff className="w-5 h-5" />
              )}
            </button>
            {/* Name change */}
            {senderName && !showNameInput && (
              <button
                onClick={() => setShowNameInput(true)}
                className="text-xs text-board-muted hover:text-board-text px-2.5 py-1.5 rounded-lg border border-board-border transition-colors"
              >
                {senderName}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Name input overlay */}
      {showNameInput && (
        <div className="shrink-0 px-4 py-3 border-b border-board-border/50 bg-board-card">
          <label className="text-xs text-board-muted mb-1.5 block">Your name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSetName()}
              placeholder="Enter your name"
              autoFocus
              className="flex-1 px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
            />
            <button
              onClick={handleSetName}
              disabled={!senderName.trim()}
              className="px-5 py-2.5 rounded-xl bg-fire-500 text-white text-sm font-medium disabled:opacity-40 transition-colors"
            >
              Join
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-3 space-y-1.5 min-h-0">
        {sortedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <MessageSquare className="w-12 h-12 text-board-muted/20 mb-3" />
            <p className="text-sm text-board-muted">No messages yet</p>
            <p className="text-xs text-board-muted/50 mt-1">Send a message to get started</p>
          </div>
        ) : (
          sortedMessages.map((msg) => {
            const isCue = msg.message.startsWith("[CUE]");
            const isAlert = msg.message.startsWith("[ALERT]");
            const type: MessageType = isCue ? "cue" : isAlert ? "alert" : "text";
            const style = MESSAGE_STYLES[type];
            const isOwn = msg.senderName === senderName;

            return (
              <div
                key={msg.id}
                className={`px-3.5 py-2.5 rounded-2xl border border-transparent ${style.bg} ${
                  isOwn ? "ml-8 bg-fire-500/5" : "mr-8"
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`text-xs font-semibold shrink-0 ${isOwn ? "text-fire-500" : "text-blue-400"}`}>
                    {isOwn ? "You" : msg.senderName}
                  </span>
                  <span className="text-[10px] text-board-muted/50">
                    {timeAgo(msg.createdAt)}
                  </span>
                </div>
                <p className={`text-sm mt-0.5 leading-relaxed break-words ${style.text}`}>
                  {msg.message}
                </p>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {!showNameInput && (
        <div className="shrink-0 border-t border-board-border bg-board-bg px-4 py-3 safe-area-bottom">
          {/* Message type selector */}
          <div className="flex items-center gap-1 mb-2">
            {(Object.keys(MESSAGE_STYLES) as MessageType[])
              .filter((t) => t !== "system")
              .map((t) => {
                const s = MESSAGE_STYLES[t];
                const Icon = s.icon;
                return (
                  <button
                    key={t}
                    onClick={() => setMsgType(t)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium uppercase tracking-wider transition-colors ${
                      msgType === t
                        ? "bg-fire-500/15 text-fire-500"
                        : "text-board-muted hover:text-board-text"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {s.label}
                  </button>
                );
              })}
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                msgType === "cue"
                  ? "Camera 2 wide..."
                  : msgType === "alert"
                    ? "Urgent message..."
                    : "Message the team..."
              }
              rows={1}
              disabled={sending}
              className="flex-1 px-4 py-3 rounded-2xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors disabled:opacity-50 resize-none"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="p-3 rounded-2xl bg-fire-500 text-white disabled:opacity-40 transition-colors shrink-0"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
