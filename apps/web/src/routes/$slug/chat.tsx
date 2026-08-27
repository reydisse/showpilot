import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode, X, Clock3, Check, Users, Link2, LockKeyhole, Wifi, MessageSquare, UserRoundPlus, CalendarDays, Hash, Search, UserCheck } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChat } from "@/hooks/useChat";
import { getActiveAdapters, getOrgSettings } from "@/lib/settings";
import { createCrewChatPass, createPlanningChatPass } from "@/lib/crew-chat-pass";
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
    const [adapters, members, settings] = await Promise.all([
      getActiveAdapters({ data: { orgId: context.orgId } }),
      getChatMembers({ data: { orgId: context.orgId } }),
      getOrgSettings({ data: { orgId: context.orgId } }),
    ]);
    const opening = await getRundownOpeningDate({ data: { orgId: context.orgId, today: getTodayDateString(settings["org-timezone"]) } });
    return { orgId: context.orgId, slug: context.slug, userId: context.user.id, userName: context.user.name, userRole: context.role, chatAdapter: adapters.chat, members, showId: opening.showId, serviceDate: opening.serviceDate };
  },
  component: ChatPage,
});

function ChatPage() {
  const { orgId, userId, userName, userRole, chatAdapter, members, showId, serviceDate } = Route.useLoaderData();
  const { room: requestedRoom, message: focusedMessageId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const roomId = requestedRoom || "production";
  const dmUserIds = roomId.startsWith("dm:") ? roomId.split(":").slice(1) : [];
  const dmMember = members.find((member) => dmUserIds.includes(member.userId) && member.userId !== userId);
  const roomTitle = roomId === "planning" ? "Planning Room" : dmMember ? dmMember.name : "Production Chat";
  const roomSubtitle = roomId === "planning" ? "Seven-day planning history" : dmMember ? `Direct message · ${dmMember.role}` : "Crew channel";
  const { messages, sendMessage, uploadAttachment, editMessage, deleteMessage, votePoll, toggleReaction, connectionStatus, unreadCount, typingUsers, setTyping, readReceipts } = useChat({ orgId, roomId, isVisible: true, chatAdapter, senderName: userName, senderRole: userRole });
  const rundown = useRundownSync(orgId, serviceDate, showId);
  const liveItem = rundown.timer.playback === "play"
    ? rundown.items.find((item) => item.id === rundown.timer.currentItemId)?.title ?? null
    : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [hours, setHours] = useState(8);
  const [joinUrl, setJoinUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [planningShareOpen, setPlanningShareOpen] = useState(false);
  const [planningHours, setPlanningHours] = useState(8);
  const [planningJoinUrl, setPlanningJoinUrl] = useState("");
  const [planningExpiresAt, setPlanningExpiresAt] = useState(0);
  const [planningMemberSearch, setPlanningMemberSearch] = useState("");
  const [selectedPlanningMembers, setSelectedPlanningMembers] = useState<string[]>([]);
  const [planningError, setPlanningError] = useState("");
  const canInvite = ["owner", "admin", "td", "pd", "pm", "sm", "stageManager", "tm"].includes(userRole);
  const openRoom = (nextRoom: string) => void navigate({ search: { room: nextRoom, message: undefined }, replace: true });
  const directRoomFor = (otherUserId: string) => `dm:${[userId, otherUserId].sort().join(":")}`;
  const visibleMembers = members.filter((member) => member.userId !== userId && member.name.toLowerCase().includes(memberSearch.toLowerCase())).slice(0, 8);
  const visiblePlanningMembers = members.filter((member) => member.userId !== userId && member.name.toLowerCase().includes(planningMemberSearch.toLowerCase()));

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

  const copyPlanningLink = async () => {
    await navigator.clipboard.writeText(planningJoinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const createPlanningLink = async () => {
    if (selectedPlanningMembers.length === 0) return;
    setCreating(true);
    setPlanningError("");
    try {
      const pass = await createPlanningChatPass({ data: { orgId, hours: planningHours, targetUserIds: selectedPlanningMembers } });
      setPlanningJoinUrl(`${window.location.origin}/join/chat/planning/${encodeURIComponent(pass.token)}`);
      setPlanningExpiresAt(pass.expiresAt);
    } catch (error) {
      setPlanningError(error instanceof Error ? error.message : "Could not create the Planning Room link");
    } finally {
      setCreating(false);
    }
  };

  const openPlanningShare = () => {
    setPlanningShareOpen(true);
    setPlanningJoinUrl("");
    setPlanningError("");
    setCopied(false);
    setSelectedPlanningMembers([]);
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
          onVotePoll={votePoll}
          onToggleReaction={toggleReaction}
          mentionMembers={members.filter((member) => member.userId !== userId)}
          focusedMessageId={focusedMessageId}
          currentUserName={userName}
          currentUserId={userId}
          title={roomTitle}
          subtitle={roomSubtitle}
          typingUsers={typingUsers}
          onTypingChange={roomId !== "production" || chatAdapter === "native" ? setTyping : undefined}
          seenThrough={dmMember ? readReceipts[dmMember.userId] : undefined}
          className="h-full"
          liveStatus={liveItem}
          headerActions={<div className="flex items-center gap-2 lg:hidden">
            <select value={roomId} onChange={(event) => openRoom(event.target.value)} aria-label="Switch chat room" className="max-w-36 rounded-lg border border-board-border bg-board-bg px-2 py-2 text-[10px] font-medium text-board-text outline-none">
              <option value="production">Production Chat</option>
              <option value="planning">Planning Room</option>
              {members.filter((member) => member.userId !== userId).map((member) => <option key={member.userId} value={directRoomFor(member.userId)}>DM · {member.name}</option>)}
            </select>
            {canInvite && roomId === "production" ? <button onClick={() => setShareOpen(true)} className="group flex items-center gap-2 rounded-lg border border-board-border bg-board-bg/55 p-2 text-board-muted transition hover:border-fire-500/30 hover:text-board-text" title="Invite guest crew"><Users className="h-4 w-4 transition-colors group-hover:text-fire-400" /></button> : null}
            {canInvite && roomId === "planning" ? <button onClick={openPlanningShare} className="group flex items-center gap-2 rounded-lg border border-board-border bg-board-bg/55 p-2 text-board-muted transition hover:border-fire-500/30 hover:text-board-text" title="Share Planning Room"><UserCheck className="h-4 w-4 transition-colors group-hover:text-fire-400" /></button> : null}
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
          {roomId === "planning" && canInvite && <section>
            <div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted">Targeted access</p><UserCheck className="h-3.5 w-3.5 text-board-muted" /></div>
            <p className="mt-2 text-[10px] leading-4 text-board-muted">Send selected members an expiring link that opens this Planning Room.</p>
            <button onClick={openPlanningShare} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-fire-500/35 bg-fire-500/[0.07] px-3 py-2.5 text-xs font-semibold text-fire-400 transition hover:bg-fire-500/15"><Link2 className="h-4 w-4" />Share with members</button>
          </section>}
          {roomId === "planning" && canInvite && <div className="h-px bg-board-border" />}
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
              <button type="button" onClick={() => setShareOpen(false)} aria-label="Close guest crew invite" title="Close guest crew invite" className="rounded-lg p-2 text-board-muted hover:bg-board-border/50 hover:text-board-text"><X className="h-4 w-4" /></button>
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

      {planningShareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && setPlanningShareOpen(false)}>
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-board-border bg-board-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-board-border px-5 py-4">
              <div><h2 className="text-base font-semibold text-board-text">Share Planning Room</h2><p className="text-xs text-board-muted">Only the selected signed-in members can use this invite.</p></div>
              <button type="button" onClick={() => setPlanningShareOpen(false)} aria-label="Close Planning Room invite" title="Close Planning Room invite" className="rounded-lg p-2 text-board-muted hover:bg-board-border/50 hover:text-board-text"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5 sm:p-6">
              {!planningJoinUrl ? (
                <div className="grid gap-6 sm:grid-cols-[1.1fr_0.9fr]">
                  <div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-fire-500/20 bg-fire-500/10 text-fire-400"><UserCheck className="h-5 w-5" /></div>
                    <h3 className="mt-4 text-lg font-semibold text-board-text">Choose who should join</h3>
                    <p className="mt-2 text-sm leading-6 text-board-muted">Select one or more organization members. The link opens directly into Planning and expires automatically.</p>
                    <div className="mt-5 rounded-xl border border-board-border bg-board-bg/45 p-3 text-xs leading-5 text-board-muted"><LockKeyhole className="mr-2 inline h-4 w-4 text-fire-400" />Invitees must sign in with their ShowPilot account.</div>
                  </div>
                  <div className="rounded-xl border border-board-border bg-board-bg/35 p-4">
                    <label className="mb-2 block text-[10px] font-semibold uppercase tracking-wider text-board-muted">Members</label>
                    <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-board-muted" /><input value={planningMemberSearch} onChange={(event) => setPlanningMemberSearch(event.target.value)} placeholder="Search members" className="w-full rounded-lg border border-board-border bg-board-bg/60 py-2 pl-8 pr-2 text-[10px] text-board-text outline-none focus:border-fire-500/35" /></div>
                    <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">{visiblePlanningMembers.map((member) => { const selected = selectedPlanningMembers.includes(member.userId); return <button key={member.userId} onClick={() => setSelectedPlanningMembers((current) => selected ? current.filter((id) => id !== member.userId) : [...current, member.userId])} className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${selected ? "border-fire-500/45 bg-fire-500/10" : "border-transparent hover:bg-board-border/40"}`}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-400/10 text-[8px] font-bold text-sky-300">{member.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("")}</span><span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-medium text-board-text">{member.name}</span><span className="block text-[8px] uppercase tracking-wide text-board-muted">{member.role}</span></span>{selected && <Check className="h-3.5 w-3.5 text-fire-400" />}</button>; })}</div>
                    <label className="mb-2 mt-4 block text-[10px] font-semibold uppercase tracking-wider text-board-muted">Link duration</label>
                    <div className="grid grid-cols-3 gap-2">{[2, 8, 24].map((value) => <button key={value} onClick={() => setPlanningHours(value)} className={`rounded-lg border px-2 py-2.5 text-xs font-medium ${planningHours === value ? "border-fire-500/50 bg-fire-500/10 text-fire-400" : "border-board-border text-board-muted hover:text-board-text"}`}>{value}h</button>)}</div>
                    {planningError && <p className="mt-3 text-[10px] text-red-300">{planningError}</p>}
                    <button disabled={creating || selectedPlanningMembers.length === 0} onClick={createPlanningLink} className="mt-4 w-full rounded-xl bg-fire-500 px-4 py-3 text-sm font-semibold text-black transition hover:bg-fire-400 disabled:opacity-50">{creating ? "Creating link…" : `Create link${selectedPlanningMembers.length ? ` for ${selectedPlanningMembers.length}` : ""}`}</button>
                  </div>
                </div>
              ) : (
                <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
                  <div className="mx-auto rounded-2xl bg-white p-4 shadow-lg"><QRCodeSVG value={planningJoinUrl} size={190} level="M" /></div>
                  <div>
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/10 text-green-400"><Link2 className="h-5 w-5" /></div>
                    <h3 className="mt-4 text-lg font-semibold text-board-text">Planning link is ready</h3>
                    <p className="mt-2 text-sm leading-6 text-board-muted">Share it with the selected members. It opens the Planning Room after they sign in.</p>
                    <button onClick={copyPlanningLink} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-board-border bg-board-bg/50 px-4 py-3 text-xs font-medium text-board-text hover:border-fire-500/30">{copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy invite link"}</button>
                    <p className="mt-3 text-center text-[10px] text-board-muted">Expires {new Date(planningExpiresAt).toLocaleString()} · {selectedPlanningMembers.length} selected member{selectedPlanningMembers.length === 1 ? "" : "s"}</p>
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
