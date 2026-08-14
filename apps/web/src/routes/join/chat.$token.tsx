import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { MessageSquare, ShieldCheck } from "lucide-react";
import { validateCrewChatPass } from "@/lib/crew-chat-pass";
import { useChat } from "@/hooks/useChat";
import { ChatPanel } from "@/components/chat/ChatPanel";

export const Route = createFileRoute("/join/chat/$token")({
  loader: async ({ params }) => ({ pass: await validateCrewChatPass({ data: params.token }), token: params.token }),
  component: GuestChatJoinPage,
});

function GuestChatJoinPage() {
  const { pass, token } = Route.useLoaderData();
  const [name, setName] = useState("");
  const [joinedName, setJoinedName] = useState("");
  const chat = useChat({ orgId: pass?.orgId ?? "", isVisible: true, chatAdapter: "native", senderName: joinedName, senderRole: "Guest", guestToken: joinedName ? token : undefined });

  if (!pass) return <div className="flex min-h-[100dvh] items-center justify-center bg-board-bg p-6"><div className="max-w-sm text-center"><ShieldCheck className="mx-auto h-10 w-10 text-board-muted" /><h1 className="mt-4 text-xl font-semibold text-board-text">This crew pass has expired</h1><p className="mt-2 text-sm text-board-muted">Ask a production leader for a new QR code or join link.</p><Link to="/login" className="mt-5 inline-block text-sm text-fire-400">Member sign in</Link></div></div>;

  if (!joinedName) return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-board-bg p-4">
      <div className="w-full max-w-sm rounded-2xl border border-board-border bg-board-card p-6 shadow-2xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-fire-500/10 text-fire-400"><MessageSquare className="h-5 w-5" /></div>
        <h1 className="mt-5 text-xl font-semibold text-board-text">Join production chat</h1>
        <p className="mt-1 text-sm text-board-muted">Enter the name your crew will recognize. You’ll join as temporary guest crew.</p>
        <label className="mt-6 block text-xs font-medium text-board-text">Display name</label>
        <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && name.trim() && setJoinedName(name.trim())} autoFocus maxLength={60} placeholder="e.g. Ama — Camera 2" className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-4 py-3 text-sm text-board-text outline-none focus:border-fire-500/50" />
        <button onClick={() => name.trim() && setJoinedName(name.trim())} disabled={!name.trim()} className="mt-3 w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black disabled:opacity-40">Join Team Chat</button>
        <p className="mt-4 text-center text-[10px] text-board-muted">Guest access expires automatically. Production leaders can identify guest messages.</p>
      </div>
    </div>
  );

  return <div className="h-[100dvh] bg-board-bg p-2 sm:p-4"><div className="mx-auto h-full max-w-4xl overflow-hidden rounded-xl border border-board-border bg-board-card"><ChatPanel messages={chat.messages} connectionStatus={chat.connectionStatus} unreadCount={chat.unreadCount} onSendMessage={chat.sendMessage} onUploadAttachment={chat.uploadAttachment} typingUsers={chat.typingUsers} onTypingChange={chat.setTyping} attachmentAccessToken={token} currentUserName={joinedName} title="Team Chat" subtitle={`${joinedName} · Guest crew`} allowOperationalMessages={false} className="h-full" /></div></div>;
}
