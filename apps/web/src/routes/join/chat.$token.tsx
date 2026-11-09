import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { validateCrewChatPass } from "@/lib/crew-chat-pass";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useChat } from "@/hooks/useChat";
import { ChatInviteNotice } from "@/components/chat/ChatInviteNotice";
import type { CrewChatClaims, CrewChatJoinState } from "@/lib/chat-pass-token";
import { ChatPanel } from "@/components/chat/ChatPanel";

export const Route = createFileRoute("/join/chat/$token")({
  staleTime: 0,
  preloadStaleTime: 0,
  loader: async ({ params, abortController }) => ({ pass: await validateCrewChatPass({ data: params.token, signal: abortController.signal }), token: params.token }),
  component: GuestChatJoinPage,
});

function GuestChatJoinPage() {
  const { pass, token } = Route.useLoaderData();
  if (pass.status !== "valid") return <ChatInviteNotice kind="crew" status={pass.status} />;
  return <GuestChatAccess key={token} token={token} pass={pass.pass} />;
}

function GuestChatAccess({ token, pass }: { token: string; pass: CrewChatClaims }) {
  const [name, setName] = useState("");
  const [joinedName, setJoinedName] = useState("");
  const [denied, setDenied] = useState<"revoked" | "invalid" | "expired" | "unavailable" | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = pass.exp * 1000 - Date.now();
      if (remaining <= 0) setExpired(true);
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [pass.exp]);
  if (denied) return <ChatInviteNotice kind="crew" status={denied} />;
  if (expired) return <ChatInviteNotice kind="crew" status="expired" />;
  if (!joinedName) return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-board-bg p-4">
      <div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-fire-500/10 text-fire-400"><MessageSquare className="h-5 w-5" /></div>
        <h1 className="mt-5 text-xl font-semibold text-board-text">Join production chat</h1>
        <p className="mt-1 text-sm text-board-muted">Enter the name your crew will recognize. You’ll join as temporary guest crew.</p>
        <label htmlFor="crew-chat-display-name" className="mt-6 block text-xs font-medium text-board-text">Display name</label>
        <input id="crew-chat-display-name" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && name.trim() && setJoinedName(name.trim())} autoFocus maxLength={60} placeholder="e.g. Ama — Camera 2" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-sm text-board-text outline-none focus:border-fire-500/50" />
        <button onClick={() => name.trim() && setJoinedName(name.trim())} disabled={!name.trim()} className="mt-3 min-h-11 w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black disabled:opacity-40">Join Team Chat</button>
        <p className="mt-4 text-center text-[10px] text-board-muted">Guest access expires automatically. Production leaders can identify guest messages.</p>
      </div>
    </div>
  );

  return <GuestChatSession orgId={pass.orgId} token={token} name={joinedName} onDenied={setDenied} />;
}

function GuestChatSession({ orgId, token, name: joinedName, onDenied }: { orgId: string; token: string; name: string; onDenied: (status: "revoked" | "invalid" | "expired" | "unavailable") => void }) {
  const chat = useChat({ orgId, isVisible: true, senderName: joinedName, senderRole: "Guest", guestToken: token });
  const read = useCallback((signal: AbortSignal) => validateCrewChatPass({ data: token, signal }), [token]);
  const access = useOperatorRead<CrewChatJoinState | null>({ key: token, initialValue: null, read,
    errorMessage: "Could not recheck this crew link. Try again.",
    enabled: chat.connectionStatus === "error" || chat.connectionStatus === "disconnected" });
  useEffect(() => {
    if (chat.guestAccessRevoked) onDenied("revoked");
    else if (access.value && access.value.status !== "valid") onDenied(access.value.status);
  }, [chat.guestAccessRevoked, access.value, onDenied]);
  return <div className="flex h-[100dvh] flex-col bg-board-bg p-2 sm:p-4">
    {access.error && <div role="alert" className="mx-auto w-full max-w-4xl shrink-0 p-3 text-sm text-red-300"><p>{access.error.message}</p><button className="min-h-11 rounded-lg border border-board-border px-4" onClick={access.retry} disabled={access.refreshing}>Recheck link</button></div>}<div className="mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-hidden rounded-xl border border-board-border bg-board-card"><ChatPanel messages={chat.messages} connectionStatus={chat.connectionStatus} unreadCount={chat.unreadCount} onSendMessage={chat.sendMessage} attachmentDraft={chat.attachmentDraft} composer={chat.composer} typingUsers={chat.typingUsers} onTypingChange={chat.setTyping} attachmentAccessToken={token} currentUserName={joinedName} title="Team Chat" subtitle={`${joinedName} · Guest crew`} allowOperationalMessages={false} className="h-full" gatewayStatus={chat.gatewayStatus} hydrated={chat.hydrated} connectionUpdatedAt={chat.connectionUpdatedAt} onReconnect={chat.retryConnection} hasOlderMessages={chat.hasOlderMessages} loadingOlderMessages={chat.loadingOlderMessages} olderMessagesError={chat.olderMessagesError} onLoadOlderMessages={chat.loadOlderMessages} onRetryQueuedMessage={chat.retryQueuedMessage} onCancelQueuedMessage={chat.cancelQueuedMessage} /></div></div>;
}
