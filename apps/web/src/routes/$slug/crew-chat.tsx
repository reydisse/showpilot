import { createFileRoute, Link } from "@tanstack/react-router";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Bell, BellOff } from "lucide-react";
import { requestNotificationPermission } from "@/lib/notifications";
import { getActiveAdapters } from "@/lib/settings";
import { useChat } from "@/hooks/useChat";
import { ChatPanel } from "@/components/chat/ChatPanel";

export const Route = createFileRoute("/$slug/crew-chat")({
  pendingComponent: () => <BoardSkeleton />,
  validateSearch: (search: Record<string, unknown>) => ({
    name: (search.name as string) || "",
  }),
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "chat:access", context.slug, context.orgId);
    const adapters = await getActiveAdapters({ data: { orgId: context.orgId } });
    return {
      orgId: context.orgId,
      slug: context.slug,
      chatAdapter: adapters.chat,
    };
  },
  component: CrewChatPage,
});

function CrewChatPage() {
  const { orgId, slug, chatAdapter } = Route.useLoaderData();
  const { name: searchName } = Route.useSearch();
  const [senderName, setSenderName] = useState(() => {
    if (searchName) return searchName;
    if (typeof window !== "undefined") {
      return localStorage.getItem("showpilot-chat-name") ?? "";
    }
    return "";
  });
  const [draftName, setDraftName] = useState(senderName);
  const [showNameInput, setShowNameInput] = useState(!senderName);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");

  const { messages, sendMessage, connectionStatus } = useChat({
    orgId,
    isVisible: true,
    chatAdapter,
    senderName,
    senderRole: "Crew",
  });

  useEffect(() => {
    if (searchName && typeof window !== "undefined") {
      localStorage.setItem("showpilot-chat-name", searchName);
      setSenderName(searchName);
      setDraftName(searchName);
      setShowNameInput(false);
    }
  }, [searchName]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  const handleSetName = useCallback(() => {
    if (!draftName.trim()) return;
    const nextName = draftName.trim();
    localStorage.setItem("showpilot-chat-name", nextName);
    setSenderName(nextName);
    setShowNameInput(false);
  }, [draftName]);

  const handleNotificationToggle = async () => {
    const result = await requestNotificationPermission();
    setNotifPermission(result);
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-board-bg">
      <div className="shrink-0 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 py-3 safe-area-top">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to={`/${slug}/checkin`}
              className="p-2 -ml-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-board-text">Production Chat</h1>
              <p className="text-[11px] text-board-muted truncate">
                {showNameInput ? "Join with your name" : `Signed in as ${senderName}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
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
            {!showNameInput && (
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

      {showNameInput ? (
        <div className="flex-1 px-4 py-6">
          <div className="max-w-md mx-auto rounded-3xl bg-board-card border border-board-border p-5 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-board-text">Join chat</h2>
              <p className="text-sm text-board-muted mt-1">
                Enter your name once. After that, chat opens straight into the conversation.
              </p>
            </div>
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSetName()}
              placeholder="Your name"
              autoFocus
              className="w-full px-4 py-3 rounded-2xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/40 focus:outline-none focus:border-fire-500/50 transition-colors"
            />
            <button
              onClick={handleSetName}
              disabled={!draftName.trim()}
              className="w-full px-4 py-3 rounded-2xl bg-fire-500 text-white font-medium disabled:opacity-40 transition-colors"
            >
              Open chat
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <ChatPanel
            messages={messages}
            connectionStatus={connectionStatus}
            unreadCount={0}
            onSendMessage={sendMessage}
            title="Production Chat"
            subtitle={chatAdapter === "native" ? "ShowPilot native" : `Connected via ${chatAdapter}`}
            className="border-l-0 h-full"
          />
        </div>
      )}
    </div>
  );
}
