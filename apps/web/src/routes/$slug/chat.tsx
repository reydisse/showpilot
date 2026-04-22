import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useEffect, useRef, useState } from "react";
import { MessageSquare, AlertCircle, Radio, Terminal, X } from "lucide-react";
import { getChatMessages, sendChatMessage } from "@/lib/chat";

type MessageType = "text" | "alert" | "cue" | "system";

const MESSAGE_STYLES: Record<MessageType, { bg: string; text: string; label: string; icon: React.ElementType }> = {
  text: { bg: "", text: "text-board-text/90", label: "Message", icon: MessageSquare },
  alert: { bg: "bg-red-500/10 border-red-500/30", text: "text-red-300", label: "Alert", icon: AlertCircle },
  cue: { bg: "bg-amber-500/10 border-amber-500/30", text: "text-amber-300 font-mono", label: "Cue", icon: Radio },
  system: { bg: "bg-board-border/30", text: "text-board-muted italic", label: "System", icon: Terminal },
};

export const Route = createFileRoute("/$slug/chat")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "chat:access", context.slug, context.orgId);
    const messages = await getChatMessages({ data: { orgId: context.orgId, limit: 100 } });
    return { messages, orgId: context.orgId };
  },
  component: ChatPage,
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

function ChatPage() {
  const { messages: initialMessages, orgId } = Route.useLoaderData();
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [senderName, setSenderName] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("showpilot-chat-name") ?? "";
    }
    return "";
  });
  const [showNameInput, setShowNameInput] = useState(!senderName);
  const [msgType, setMsgType] = useState<MessageType>("text");
  const [sending, setSending] = useState(false);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, dismissedAlertIds.size]);

  const handleSetName = () => {
    if (!senderName.trim()) return;
    localStorage.setItem("showpilot-chat-name", senderName.trim());
    setShowNameInput(false);
  };

  const handleSend = async () => {
    if (!input.trim() || !senderName.trim()) return;
    setSending(true);
    try {
      const text = msgType === "cue"
        ? `[CUE] ${input.trim()}`
        : msgType === "alert"
          ? `[ALERT] ${input.trim()}`
          : input.trim();
      await sendChatMessage({ data: { orgId, message: text, senderName: senderName.trim() } });
      setInput("");
      const fresh = await getChatMessages({ data: { orgId, limit: 100 } });
      setMessages(fresh);
    } catch {
      // Keep last state
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const sortedMessages = [...messages].reverse();
  const activeAlerts = sortedMessages.filter(
    (msg) => msg.message.startsWith("[ALERT]") && !dismissedAlertIds.has(msg.id),
  );
  const timelineMessages = sortedMessages.filter(
    (msg) => !msg.message.startsWith("[ALERT]"),
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 sm:px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              Production Chat
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Team communication during live production
            </p>
          </div>
          {senderName && !showNameInput && (
            <button
              onClick={() => setShowNameInput(true)}
              className="text-xs text-board-muted hover:text-board-text px-3 py-1.5 rounded-lg border border-board-border transition-colors"
            >
              {senderName}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col max-w-3xl mx-auto w-full px-4 sm:px-6">
        {/* Name input */}
        {showNameInput && (
          <div className="py-4 border-b border-board-border/50">
            <label className="text-xs text-board-muted mb-1.5 block">Your name</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSetName()}
                placeholder="Enter your name"
                className="flex-1 px-3 py-2 rounded-lg bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
              />
              <button
                onClick={handleSetName}
                disabled={!senderName.trim()}
                className="px-4 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium disabled:opacity-40 transition-colors"
              >
                Set
              </button>
            </div>
          </div>
        )}

        {activeAlerts.length > 0 && (
          <div className="py-3 border-b border-red-500/20 bg-red-500/5 space-y-2">
            {activeAlerts.map((msg) => (
              <div key={msg.id} className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-red-200">{msg.senderName}</span>
                    <span className="text-[10px] text-red-200/60">{timeAgo(msg.createdAt)}</span>
                  </div>
                  <p className="text-sm mt-1 leading-relaxed break-words text-red-100">
                    {msg.message.replace(/^\[ALERT\]\s*/, "")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDismissedAlertIds((current) => {
                      const next = new Set(current);
                      next.add(msg.id);
                      return next;
                    });
                  }}
                  className="rounded-md p-1 text-red-200/70 hover:text-red-50 hover:bg-red-500/10 transition-colors touch-manipulation"
                  aria-label="Dismiss alert"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-auto py-4 space-y-2 hide-scrollbar min-h-0">
          {timelineMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <MessageSquare className="w-10 h-10 text-board-muted/20 mb-3" />
              <p className="text-sm text-board-muted">No messages yet</p>
              <p className="text-xs text-board-muted/50 mt-1">
                {activeAlerts.length > 0 ? "Only active alerts are showing right now" : "Send a message to get started"}
              </p>
            </div>
          ) : (
            timelineMessages.map((msg) => {
              const isCue = msg.message.startsWith("[CUE]");
              const isAlert = msg.message.startsWith("[ALERT]");
              const type: MessageType = isCue ? "cue" : isAlert ? "alert" : "text";
              const style = MESSAGE_STYLES[type];

              return (
                <div
                  key={msg.id}
                  className={`px-4 py-2.5 rounded-xl border border-transparent ${style.bg}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-fire-500 shrink-0">
                      {msg.senderName}
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
          <div ref={scrollRef} />
        </div>

        {/* Input */}
        {!showNameInput && (
          <div className="shrink-0 py-4 border-t border-board-border/50 safe-area-bottom">
            {/* Message type selector */}
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              {(Object.keys(MESSAGE_STYLES) as MessageType[]).filter(t => t !== "system").map((t) => {
                const s = MESSAGE_STYLES[t];
                const Icon = s.icon;
                return (
                  <button
                    key={t}
                    onClick={() => setMsgType(t)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors ${
                      msgType === t
                        ? "bg-fire-500/15 text-fire-500"
                        : "text-board-muted hover:text-board-text"
                     }`}
                  >
                    <Icon className="w-3 h-3" />
                    {s.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  msgType === "cue" ? "Camera 2 wide..." :
                  msgType === "alert" ? "Urgent message..." :
                  "Message the team..."
                }
                rows={1}
                disabled={sending}
                className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors disabled:opacity-50 resize-none"
              />
              <button
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className="px-4 py-2 min-h-[44px] rounded-lg bg-fire-500 text-white text-sm font-medium disabled:opacity-40 transition-colors touch-manipulation"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
