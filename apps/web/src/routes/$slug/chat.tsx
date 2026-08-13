import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode, X, Clock3, Check, Users, Link2, LockKeyhole, Wifi, MessageSquare, UserRoundPlus, CalendarDays, Hash, Search } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChat } from "@/hooks/useChat";
import { getActiveAdapters } from "@/lib/settings";
import { createCrewChatPass } from "@/lib/crew-chat-pass";
import { getChatMembers } from "@/lib/chat-collaboration";

export const Route = createFileRoute("/$slug/chat")({
  validateSearch: (search: Record<string, unknown>) => ({ room: typeof search.room === "string" ? search.room : "production" }),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "chat:access", context.slug, context.orgId);
    const [adapters, members] = await Promise.all([
      getActiveAdapters({ data: { orgId: context.orgId } }),
      getChatMembers({ data: { orgId: context.orgId } }),
    ]);
    return { orgId: context.orgId, slug: context.slug, userId: context.user.id, userName: context.user.name, userRole: context.role, chatAdapter: adapters.chat, members };
  },
  component: ChatPage,
});

function ChatPage() {
  const { orgId, slug, userId, userName, userRole, chatAdapter, members } = Route.useLoaderData();
  const { room: requestedRoom } = Route.useSearch();
  const navigate = Route.useNavigate();
  const roomId = requestedRoom || "production";
  const dmUserIds = roomId.startsWith("dm:") ? roomId.split(":").slice(1) : [];
  const dmMember = members.find((member) => dmUserIds.includes(member.userId) && member.userId !== userId);
  const roomTitle = roomId === "planning" ? "Planning Room" : dmMember ? dmMember.name : "Production Chat";
  const roomSubtitle = roomId === "planning" ? "Seven-day planning history" : dmMember ? `Direct message · ${dmMember.role}` : "Crew channel";
  const { messages, sendMessage, uploadAttachment, editMessage, deleteMessage, connectionStatus, unreadCount } = useChat({ orgId, orgSlug: slug, roomId, isVisible: true, chatAdapter, senderName: userName, senderRole: userRole });
  const [shareOpen, setShareOpen] = useState(false);
  const [hours, setHours] = useState(8);
  const [joinUrl, setJoinUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const canInvite = ["owner", "admin", "td", "pd", "pm", "tm"].includes(userRole);
  const openRoom = (nextRoom: string) => void navigate({ search: { room: nextRoom }, replace: true });
  const directRoomFor = (otherUserId: string) => `dm:${[userId, otherUserId].sort().join(":")}`;
  const visibleMembers = members.filter((member) => member.userId !== userId && member.name.toLowerCase().includes(memberSearch.toLowerCase())).slice(0, 8);

  const createPass = async () => {
    setCreating(true);
    try {
      const pass = await createCrewChatPass({ data: { orgId, hours } });
      setJoinUrl(`${window.location.origin}/join/chat/${encodeURIComponent(pass.token)}`);
      setExpiresAt(pass.expiresAt);
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative grid h-full min-h-0 overflow-hidden bg-board-card lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-h-0 border-board-border lg:border-r">
        <ChatPanel
          messages={messages}
          connectionStatus={connectionStatus}
          unreadCount={unreadCount}
          onSendMessage={sendMessage}
          onUploadAttachment={uploadAttachment}
          onEditMessage={roomId === "production" && chatAdapter !== "native" ? undefined : editMessage}
          onDeleteMessage={roomId === "production" && chatAdapter !== "native" ? undefined : deleteMessage}
          mentionMembers={members.filter((member) => member.userId !== userId)}
          currentUserName={userName}
          currentUserId={userId}
          title={roomTitle}
          subtitle={roomSubtitle}
          className="h-full"
          headerActions={<div className="flex items-center gap-2 lg:hidden">
            <select value={roomId} onChange={(event) => openRoom(event.target.value)} aria-label="Switch chat room" className="max-w-36 rounded-lg border border-board-border bg-board-bg px-2 py-2 text-[10px] font-medium text-board-text outline-none">
              <option value="production">Production Chat</option>
              <option value="planning">Planning Room</option>
              {members.filter((member) => member.userId !== userId).map((member) => <option key={member.userId} value={directRoomFor(member.userId)}>DM · {member.name}</option>)}
            </select>
            {canInvite && roomId === "production" ? <button onClick={() => setShareOpen(true)} className="group flex items-center gap-2 rounded-lg border border-board-border bg-board-bg/55 p-2 text-board-muted transition hover:border-fire-500/30 hover:text-board-text" title="Invite guest crew"><Users className="h-4 w-4 transition-colors group-hover:text-fire-400" /></button> : null}
          </div>}
        />
      </div>

      <aside className="hidden min-h-0 overflow-y-auto bg-board-bg/35 lg:block">
        <div className="border-b border-board-border px-5 py-[1.15rem]"><h2 className="text-sm font-semibold text-board-text">Room details</h2><p className="mt-0.5 truncate text-[10px] text-board-muted">{roomTitle}</p></div>
        <div className="space-y-6 p-5">
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Rooms</p>
            <div className="mt-2 space-y-1">
              <button onClick={() => openRoom("production")} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${roomId === "production" ? "bg-fire-500/10 font-semibold text-fire-300" : "text-board-muted hover:bg-board-border/45 hover:text-board-text"}`}><Hash className="h-3.5 w-3.5" />Production Chat</button>
              <button onClick={() => openRoom("planning")} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${roomId === "planning" ? "bg-fire-500/10 font-semibold text-fire-300" : "text-board-muted hover:bg-board-border/45 hover:text-board-text"}`}><CalendarDays className="h-3.5 w-3.5" /><span className="min-w-0 flex-1">Planning Room</span><span className="text-[8px] uppercase tracking-wide opacity-60">7 days</span></button>
            </div>
          </section>
          <div className="h-px bg-board-border" />
          <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Direct messages</p><MessageSquare className="h-3.5 w-3.5 text-board-muted" /></div>
            <div className="relative mt-2"><Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-board-muted" /><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Find a teammate" className="w-full rounded-lg border border-board-border bg-board-bg/60 py-2 pl-8 pr-2 text-[10px] text-board-text outline-none focus:border-fire-500/35" /></div>
            <div className="mt-2 space-y-1">{visibleMembers.map((member) => { const dmRoom = directRoomFor(member.userId); return <button key={member.userId} onClick={() => openRoom(dmRoom)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${roomId === dmRoom ? "bg-board-border/70" : "hover:bg-board-border/40"}`}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-400/10 text-[8px] font-bold text-sky-300">{member.name.split(/\s+/).slice(0,2).map((part) => part[0]).join("")}</span><span className="min-w-0"><span className="block truncate text-[10px] font-medium text-board-text">{member.name}</span><span className="block text-[8px] uppercase tracking-wide text-board-muted">{member.role}</span></span></button>; })}</div>
          </section>
          <div className="h-px bg-board-border" />
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Room access</p>
            <div className="mt-3 flex gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500/10 text-green-400"><LockKeyhole className="h-4 w-4" /></div><div><p className="text-xs font-medium text-board-text">{dmMember ? "Private to both participants" : "Members always have access"}</p><p className="mt-1 text-[10px] leading-4 text-board-muted">{dmMember ? `Only you and ${dmMember.name} can open this conversation.` : "Signed-in organization members enter automatically."}</p></div></div>
          </section>
          <div className="h-px bg-board-border" />
          {roomId === "production" && <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Guest crew</p><UserRoundPlus className="h-3.5 w-3.5 text-board-muted" /></div>
            <p className="mt-2 text-[10px] leading-4 text-board-muted">Bring temporary operators into this room with an expiring QR pass.</p>
            {canInvite && <button onClick={() => setShareOpen(true)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-fire-500/35 bg-fire-500/[0.07] px-3 py-2.5 text-xs font-semibold text-fire-400 transition hover:bg-fire-500/15"><QrCode className="h-4 w-4" />Invite crew</button>}
          </section>}
          {roomId === "production" && <div className="h-px bg-board-border" />}
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Connection</p>
            <div className="mt-3 flex items-center gap-2"><Wifi className={`h-4 w-4 ${connectionStatus === "connected" ? "text-green-400" : "text-board-muted"}`} /><div><p className="text-xs font-medium text-board-text">{connectionStatus === "connected" ? "Connected" : connectionStatus}</p><p className="text-[10px] text-board-muted">{roomId !== "production" || chatAdapter === "native" ? "ShowPilot native" : `Via ${chatAdapter}`}</p></div></div>
          </section>
          <div className="rounded-xl border border-board-border bg-board-card/50 p-3"><MessageSquare className="h-4 w-4 text-fire-400" /><p className="mt-2 text-[11px] font-medium text-board-text">One room for the whole production</p><p className="mt-1 text-[10px] leading-4 text-board-muted">Messages, cues and urgent alerts stay together during the show.</p></div>
        </div>
      </aside>

      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && setShareOpen(false)}>
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-board-border bg-board-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-board-border px-5 py-4">
              <div><h2 className="text-base font-semibold text-board-text">Invite guest crew</h2><p className="text-xs text-board-muted">No account or organization membership required.</p></div>
              <button onClick={() => setShareOpen(false)} className="rounded-lg p-2 text-board-muted hover:bg-board-border/50 hover:text-board-text"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5 sm:p-6">
              {!joinUrl ? (
                <div className="grid gap-6 sm:grid-cols-[1fr_0.85fr]">
                  <div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-fire-500/20 bg-fire-500/10 text-fire-400"><QrCode className="h-5 w-5" /></div>
                    <h3 className="mt-4 text-lg font-semibold text-board-text">Open the room to crew</h3>
                    <p className="mt-2 text-sm leading-6 text-board-muted">Create one temporary doorway into this conversation. Crew scan, enter their name and join—no account setup.</p>
                    <div className="mt-5 rounded-xl border border-board-border bg-board-bg/45 p-3 text-xs leading-5 text-board-muted"><Clock3 className="mr-2 inline h-4 w-4 text-fire-400" />Access closes automatically. Guests can send messages, but cannot issue cues or alerts.</div>
                  </div>
                  <div className="rounded-xl border border-board-border bg-board-bg/35 p-4">
                    <label className="mb-3 block text-[10px] font-semibold uppercase tracking-wider text-board-muted">Pass duration</label>
                    <div className="space-y-2">
                      {[2, 8, 24].map((value) => <button key={value} onClick={() => setHours(value)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-xs font-medium ${hours === value ? "border-fire-500/50 bg-fire-500/10 text-fire-400" : "border-board-border text-board-muted hover:text-board-text"}`}><span>{value} hours</span>{hours === value && <Check className="h-3.5 w-3.5" />}</button>)}
                    </div>
                    <button disabled={creating} onClick={createPass} className="mt-4 w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black transition hover:bg-fire-400 disabled:opacity-50">{creating ? "Creating pass…" : "Create crew pass"}</button>
                  </div>
                </div>
              ) : (
                <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
                  <div className="mx-auto rounded-2xl bg-white p-4 shadow-lg"><QRCodeSVG value={joinUrl} size={190} level="M" /></div>
                  <div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/10 text-green-400"><Link2 className="h-5 w-5" /></div>
                    <h3 className="mt-4 text-lg font-semibold text-board-text">Crew pass is ready</h3>
                    <p className="mt-2 text-sm leading-6 text-board-muted">Put this QR on a monitor or copy the link into the crew group. Everyone enters the same live room.</p>
                    <button onClick={copyLink} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-board-border bg-board-bg/50 px-4 py-3 text-xs font-medium text-board-text hover:border-fire-500/30">{copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy join link"}</button>
                    <p className="mt-3 text-center text-[10px] text-board-muted">Expires {new Date(expiresAt).toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
