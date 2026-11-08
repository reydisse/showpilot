import { connectionLabel } from "@/lib/connection-state";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChatShareDialog } from "@/components/chat/ChatShareDialog";
import { QrCode, Users, Link2, LockKeyhole, Wifi, MessageSquare, UserRoundPlus, CalendarDays, Hash, Search, UserCheck } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { ChatPassRevocation } from "@/components/chat/ChatPassRevocation";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChat } from "@/hooks/useChat";
import { getOrgSettings } from "@/lib/settings";
import { getChatMembers } from "@/lib/chat-collaboration";
import { useRundownSync } from "@/hooks/useRundownSync";
import { getRundownOpeningDate } from "@/lib/rundown";
import { getTodayDateString } from "@/lib/utils";

export const Route = createFileRoute("/$slug/chat")({
  validateSearch: (search: Record<string, unknown>) => ({ room: typeof search.room === "string" ? search.room : "production", message: typeof search.message === "string" ? search.message : undefined }),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "chat:access", context.slug, context.orgId);
    const [members, settings] = await Promise.all([
      getChatMembers({ data: { orgId: context.orgId } }),
      getOrgSettings({ data: { orgId: context.orgId } }),
    ]);
    const opening = await getRundownOpeningDate({ data: { orgId: context.orgId, today: getTodayDateString(settings["org-timezone"]) } });
    return { orgId: context.orgId, slug: context.slug, userId: context.user.id, userName: context.user.name, userRole: context.role, members, showId: opening.showId, serviceDate: opening.serviceDate };
  },
  component: ChatPage,
});

function ChatPage() {
  const { orgId, userId, userName, userRole, members, showId, serviceDate } = Route.useLoaderData();
  const { room: requestedRoom, message: focusedMessageId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const roomId = requestedRoom;
  const dmUserIds = roomId.startsWith("dm:") ? roomId.split(":").slice(1) : [];
  const isOwnDm = dmUserIds.length === 2 && dmUserIds[0] < dmUserIds[1] && dmUserIds.includes(userId);
  const dmMember = isOwnDm ? members.find(member => dmUserIds.includes(member.userId) && member.userId !== userId) : undefined;
  const roomAvailable = roomId === "production" || roomId === "planning" || Boolean(dmMember);
  const roomTitle = roomId === "planning" ? "Planning Room" : dmMember ? dmMember.name : roomId === "production" ? "Production Chat" : "Conversation unavailable";
  const roomSubtitle = roomId === "planning" ? "Plan together before the show" : dmMember ? `Direct message · ${dmMember.role}` : "Crew channel";
  const { messages, sendMessage, uploadAttachment, discardAttachment, editMessage, deleteMessage, votePoll, toggleReaction, connectionStatus, connectionUpdatedAt, retryConnection, unreadCount, typingUsers, setTyping, readReceipts, gatewayStatus, hydrated, markRead, hasOlderMessages, loadingOlderMessages, olderMessagesError, loadOlderMessages, retryQueuedMessage, cancelQueuedMessage } = useChat({ orgId: roomAvailable ? orgId : "", roomId, isVisible: true, senderName: userName, senderRole: userRole, currentUserId: userId });
  const rundown = useRundownSync(orgId, serviceDate, showId);
  const liveItem = rundown.timer.playback === "play"
    ? rundown.items.find((item) => item.id === rundown.timer.currentItemId)?.title ?? null
    : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [planningShareOpen, setPlanningShareOpen] = useState(false);
  const [revokedToken, setRevokedToken] = useState<string | null>(null);
  const canInvite = ["owner", "admin", "td", "pd", "pm", "sm", "stageManager", "tm"].includes(userRole);
  const openRoom = (nextRoom: string) => void navigate({ search: { room: nextRoom, message: undefined } });
  const directRoomFor = (otherUserId: string) => `dm:${[userId, otherUserId].sort().join(":")}`;
  const visibleMembers = members.filter((member) => member.userId !== userId && member.name.toLowerCase().includes(memberSearch.toLowerCase()));
  const openPlanningShare = () => setPlanningShareOpen(true);

  return (
    <div className="relative grid h-full min-h-0 overflow-hidden bg-board-card lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-h-0 min-w-0 flex-col border-board-border lg:border-r">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-board-border p-2 lg:hidden">
          {canInvite && <ChatPassRevocation orgId={orgId} onRevoked={setRevokedToken} />}
          <div className="flex items-center gap-2 lg:hidden">
            <select value={roomId} onChange={(event) => openRoom(event.target.value)} aria-label="Switch chat room" className="min-h-11 max-w-36 rounded-lg border border-board-border bg-board-bg px-2 py-2 text-[10px] font-medium text-board-text outline-none">
              {!roomAvailable && <option value={roomId}>Conversation unavailable</option>}
              <optgroup label="Rooms">
                <option value="production">Production Chat</option>
                <option value="planning">Planning Room</option>
              </optgroup>
              <optgroup label="Direct messages">
                {members.filter(member => member.userId !== userId).map(member => <option key={member.userId} value={directRoomFor(member.userId)}>{member.name}</option>)}
              </optgroup>
            </select>
            {canInvite && roomId === "production" ? <button onClick={() => setShareOpen(true)} className="group flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-board-border bg-board-bg/55 p-2 text-board-muted transition hover:border-fire-500/30 hover:text-board-text" title="Invite guest crew"><Users className="h-4 w-4 transition-colors group-hover:text-fire-400" /></button> : null}
            {canInvite && roomId === "planning" ? <button onClick={openPlanningShare} className="group flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-board-border bg-board-bg/55 p-2 text-board-muted transition hover:border-fire-500/30 hover:text-board-text" title="Share Planning Room"><UserCheck className="h-4 w-4 transition-colors group-hover:text-fire-400" /></button> : null}
          </div>
        </div>
        {!roomAvailable ? <div role="alert" className="space-y-3 p-5">
          <h1 className="text-lg font-semibold">Conversation unavailable</h1>
          <p>This room does not exist or is not available to your account.</p>
          <button onClick={() => openRoom("production")} className="min-h-11 rounded-lg border border-board-border px-4">Open Production Chat</button>
        </div> : <ChatPanel
          key={`${orgId}:${roomId}`}
          messages={messages}
          connectionStatus={connectionStatus}
          unreadCount={unreadCount}
          onSendMessage={sendMessage}
          onUploadAttachment={uploadAttachment}
          onDiscardAttachment={discardAttachment}
          gatewayStatus={gatewayStatus}
          hydrated={hydrated} connectionUpdatedAt={connectionUpdatedAt} onReconnect={retryConnection}
          onReadThrough={markRead}
          hasOlderMessages={hasOlderMessages}
          loadingOlderMessages={loadingOlderMessages}
          olderMessagesError={olderMessagesError}
          onLoadOlderMessages={loadOlderMessages}
          onRetryQueuedMessage={retryQueuedMessage}
          onCancelQueuedMessage={cancelQueuedMessage}
          onEditMessage={editMessage}
          onDeleteMessage={deleteMessage}
          onVotePoll={votePoll}
          onToggleReaction={toggleReaction}
          mentionMembers={members.filter((member) => member.userId !== userId)}
          focusedMessageId={focusedMessageId}
          currentUserName={userName}
          currentUserId={userId}
          title={roomTitle}
          subtitle={roomSubtitle}
          typingUsers={typingUsers}
          onTypingChange={setTyping}
          seenThrough={dmMember ? readReceipts[dmMember.userId] : undefined}
          className="min-h-0 flex-1"
          liveStatus={liveItem}

        />}
      </div>

      <aside className="hidden min-h-0 overflow-y-auto bg-board-bg/35 lg:block">
        {canInvite && <div className="p-4"><ChatPassRevocation orgId={orgId} onRevoked={setRevokedToken} /></div>}
        <div className="border-b border-board-border px-5 py-[1.15rem]"><h2 className="text-sm font-semibold text-board-text">Room details</h2><p className="mt-0.5 truncate text-[10px] text-board-muted">{roomTitle}</p></div>
        <div className="space-y-6 p-5">
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Rooms</p>
            <div className="mt-2 space-y-1">
              <button onClick={() => openRoom("production")} aria-current={roomId === "production" ? "page" : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${roomId === "production" ? "bg-fire-500/10 font-semibold text-fire-300" : "text-board-muted hover:bg-board-border/45 hover:text-board-text"}`}><Hash className="h-3.5 w-3.5" />Production Chat</button>
              <button onClick={() => openRoom("planning")} aria-current={roomId === "planning" ? "page" : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${roomId === "planning" ? "bg-fire-500/10 font-semibold text-fire-300" : "text-board-muted hover:bg-board-border/45 hover:text-board-text"}`}><CalendarDays className="h-3.5 w-3.5" /><span className="min-w-0 flex-1">Planning Room</span></button>
            </div>
          </section>
          <div className="h-px bg-board-border" />
          <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Direct messages</p><MessageSquare className="h-3.5 w-3.5 text-board-muted" /></div>
            <div className="relative mt-2"><Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-board-muted" /><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} aria-label="Find a teammate" placeholder="Find a teammate" className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg/60 py-2 pl-8 pr-2 text-[10px] text-board-text outline-none focus:border-fire-500/35" /></div>
            <div className="mt-2 space-y-1">{visibleMembers.map((member) => { const dmRoom = directRoomFor(member.userId); return <button key={member.userId} onClick={() => openRoom(dmRoom)} aria-current={roomId === dmRoom ? "page" : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${roomId === dmRoom ? "bg-board-border/70" : "hover:bg-board-border/40"}`}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-400/10 text-[8px] font-bold text-sky-300">{member.name.split(/\s+/).slice(0,2).map((part) => part[0]).join("")}</span><span className="min-w-0"><span className="block truncate text-[10px] font-medium text-board-text">{member.name}</span><span className="block text-[8px] uppercase tracking-wide text-board-muted">{member.role}</span></span></button>; })}{visibleMembers.length === 0 && <p className="py-2 text-xs text-board-muted">{memberSearch ? "No teammates match your search." : "No other teammates yet."}</p>}</div>
          </section>
          <div className="h-px bg-board-border" />
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Room access</p>
            <div className="mt-3 flex gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500/10 text-green-400"><LockKeyhole className="h-4 w-4" /></div><div><p className="text-xs font-medium text-board-text">{dmMember ? "Private to both participants" : roomAvailable ? "Workspace chat access" : "Room unavailable"}</p><p className="mt-1 text-[10px] leading-4 text-board-muted">{dmMember ? `Only you and ${dmMember.name} can open this conversation.` : roomAvailable ? "Members with chat access can open this room directly." : "Choose a room or teammate to continue."}</p></div></div>
          </section>
          <div className="h-px bg-board-border" />
          {roomId === "production" && <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Guest crew</p><UserRoundPlus className="h-3.5 w-3.5 text-board-muted" /></div>
            <p className="mt-2 text-[10px] leading-4 text-board-muted">Bring temporary operators into this room with an expiring QR pass.</p>
            {canInvite && <button onClick={() => setShareOpen(true)} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-fire-500/35 bg-fire-500/[0.07] px-3 py-2.5 text-xs font-semibold text-fire-400 transition hover:bg-fire-500/15"><QrCode className="h-4 w-4" />Invite crew</button>}
          </section>}
          {roomId === "production" && <div className="h-px bg-board-border" />}
          {roomId === "planning" && canInvite && <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Targeted access</p><UserCheck className="h-3.5 w-3.5 text-board-muted" /></div>
            <p className="mt-2 text-[10px] leading-4 text-board-muted">Send selected members an expiring link that opens this Planning Room.</p>
            <button onClick={openPlanningShare} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-fire-500/35 bg-fire-500/[0.07] px-3 py-2.5 text-xs font-semibold text-fire-400 transition hover:bg-fire-500/15"><Link2 className="h-4 w-4" />Share with members</button>
          </section>}
          {roomId === "planning" && canInvite && <div className="h-px bg-board-border" />}
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Connection</p>
            <div className="mt-3 flex items-center gap-2"><Wifi className={`h-4 w-4 ${connectionStatus === "connected" ? "text-green-400" : "text-board-muted"}`} /><div><p className="text-xs font-medium text-board-text">{connectionLabel[connectionStatus]}</p><p className="text-[10px] text-board-muted">{roomId !== "production" || gatewayStatus.platform === null ? "ShowPilot Chat" : `ShowPilot Chat · ${gatewayStatus.platform} synced`}</p></div></div>
          </section>
          {roomId === "production" && <div className="rounded-xl border border-board-border bg-board-card/50 p-3"><MessageSquare className="h-4 w-4 text-fire-400" /><p className="mt-2 text-[11px] font-medium text-board-text">One room for the whole production</p><p className="mt-1 text-[10px] leading-4 text-board-muted">Messages, cues and urgent alerts stay together during the show.</p></div>}
        </div>
      </aside>

      {canInvite && <>
        <ChatShareDialog key={`${orgId}:crew`} orgId={orgId} scope="crew-chat" members={members} open={shareOpen} onOpenChange={setShareOpen} revokedToken={revokedToken} />
        <ChatShareDialog key={`${orgId}:planning`} orgId={orgId} scope="planning-chat" members={members.filter(member => member.userId !== userId)} open={planningShareOpen} onOpenChange={setPlanningShareOpen} revokedToken={revokedToken} />
      </>}

    </div>
  );
}
