import { createPortal } from "react-dom";
import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { composerFields } from "@showpilot/shared/chat-composer";
import type { WebChatComposer } from "@/lib/chat-composer";
import type { WebChatAttachmentDraft } from "@/lib/chat-attachment-draft";
import type { ChatAttachmentWork } from "@showpilot/shared/chat-attachment-draft";
import { chatEditTime, chatMutationSummary, chatMutationOutcomeMessage } from "@showpilot/shared/chat-mutation";
import { ChatMutationTrackedError, type ChatMutationWork } from "@showpilot/shared/chat-mutation-tracker";
import type { ChatNotificationWork } from "@/lib/chat-notifications";
import { connectionLabel } from "@/lib/connection-state";
import { useLayoutEffect, useSyncExternalStore, useState, useRef, useEffect, useMemo, useCallback, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { isEmojiReaction, QUICK_REACTION_EMOJIS } from "@showpilot/shared";
import {
  MessageSquare,
  Send,
  AlertTriangle,
  Radio,
  ChevronDown,
  X,
  Hash,
  Paperclip,
  Reply,
  FileText,
  Download,
  Pencil,
  Trash2,
  AtSign,
  BarChart3,
  Plus,
  Smile,
  SmilePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ChatGatewayStatus, ChatMessage, ChatMessageOptions, ChatTypingState, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import type { ChatMemberSummary } from "@/lib/chat-collaboration";
import { insertMention as insertMentionText, mentionedUserIds, mentionSearch } from "@/lib/chat-mentions";

// -- Message type selector --

type ComposedMessageType = Exclude<MessageType, "system">;
const MESSAGE_TYPES: { value: ComposedMessageType; label: string; icon: React.ReactNode }[] = [
  { value: "text", label: "Text", icon: <MessageSquare className="w-3 h-3" /> },
  { value: "cue", label: "Cue", icon: <Radio className="w-3 h-3" /> },
  { value: "alert", label: "Alert", icon: <AlertTriangle className="w-3 h-3" /> },
];
const MESSAGE_REACTIONS = QUICK_REACTION_EMOJIS;

function ExternalDeliveryStatus({ delivery, alignRight = false }: { delivery: ChatMessage["externalDelivery"]; alignRight?: boolean }) {
  if (!delivery || delivery.status !== "failed") return null;
  return <p role="alert" className={cn("mt-1 px-2 text-xs text-red-300", alignRight && "text-right")}>Your message could not reach {delivery.platform}.</p>;
}

function MessageTypeSelector({
  value,
  onChange,
}: {
  value: ComposedMessageType;
  onChange: (type: ComposedMessageType) => void;
}) {
  return (
    <div className="inline-flex shrink-0 gap-0.5 rounded-[7px] bg-[var(--sa-surface-2)] p-0.5">
      {MESSAGE_TYPES.map((mt) => (
        <button
          key={mt.value}
          type="button"
          aria-pressed={value === mt.value}
          onClick={() => onChange(mt.value)}
          className={cn(
            "flex h-[26px] items-center gap-[5px] rounded-[5px] px-2 text-xs transition-colors [@media(pointer:coarse)]:h-9",
            mt.value === "cue" && "[&>svg]:text-[var(--sa-warn)]",
            mt.value === "alert" && "[&>svg]:text-[var(--sa-danger)]",
            value === mt.value
              ? mt.value === "cue"
                ? "bg-[var(--sa-warn)]/[0.12] text-[var(--sa-warn)]"
                : mt.value === "alert"
                  ? "bg-[var(--sa-surface-3)] text-[var(--sa-danger)]"
                  : "bg-[var(--sa-surface-3)] text-board-text"
              : "text-[var(--sa-ink-3)] hover:text-board-text",
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
      aria-label={`Chat: ${connectionLabel[status]}`}
      className={cn(
        "w-2 h-2 rounded-full shrink-0 transition-colors",
        status === "connected" && "bg-green-500",
        (status === "connecting" || status === "reconnecting") && "bg-yellow-500",
        (status === "disconnected" || status === "disabled") && "bg-gray-500",
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
  onReply,
  onEdit,
  onDelete,
  attachmentAccessToken,
  isSeen = false,
  currentUserId,
  onVotePoll,
  onSetReaction,
  onOpenImage,
  onRetryQueued,
  onCancelQueued,
  mutationPending = false,
}: {
  message: ChatMessage;
  isPinned?: boolean;
  grouped?: boolean;
  isOwn?: boolean;
  onReply?: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage) => void;
  onDelete?: (message: ChatMessage) => void;
  attachmentAccessToken?: string;
  isSeen?: boolean;
  currentUserId?: string;
  onVotePoll?: (messageId: string, optionId: string, expectedOptionId: string | null) => Promise<void>;
  onSetReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onOpenImage?: (image: { name: string; url: string }) => void;
  onRetryQueued?: (messageId: string) => void;
  onCancelQueued?: (messageId: string) => void;
  mutationPending?: boolean;
}) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const reactionToggleRef = useRef<HTMLButtonElement>(null);
  const reactionPickerRef = useRef<HTMLDivElement>(null);
  const [reactionPosition, setReactionPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!reactionPickerOpen) return;
    const button = reactionToggleRef.current;
    const picker = reactionPickerRef.current;
    if (!button || !picker) return;
    const anchor = button.getBoundingClientRect();
    const card = picker.getBoundingClientRect();
    setReactionPosition({
      left: Math.max(16, Math.min(anchor.right - card.width, window.innerWidth - card.width - 16)),
      top: anchor.bottom + 4 + card.height <= window.innerHeight - 16
        ? anchor.bottom + 4
        : Math.max(16, anchor.top - card.height - 4),
    });
    const close = () => setReactionPickerOpen(false);
    const scrollRegion = button.closest('[data-testid="chat-scroll-region"]');
    scrollRegion?.addEventListener("scroll", close);
    window.addEventListener("resize", close);
    return () => {
      scrollRegion?.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [reactionPickerOpen]);
  const [customReaction, setCustomReaction] = useState("");
  const isEvent = message.type === "cue" || message.type === "alert";
  const attachmentUrl = (url: string) => attachmentAccessToken
    ? `${url}${url.includes("?") ? "&" : "?"}guestToken=${encodeURIComponent(attachmentAccessToken)}`
    : url;
  const textLines = message.text.split("\n");
  const embeddedFileUrls = message.attachments?.length ? [] : textLines.filter((line) => /^\/api\/chat-file\/[^\s]+$/.test(line.trim())).map((line) => line.trim());
  const displayText = embeddedFileUrls.length ? textLines.filter((line) => !embeddedFileUrls.includes(line.trim())).join("\n").trim() : message.text;
  const attachments = message.attachments ?? [];
  const containsOnlyImages = !message.deletedAt
    && !displayText
    && !message.replyTo
    && !message.poll
    && (attachments.length > 0 && attachments.every((attachment) => attachment.mimeType.startsWith("image/"))
      || embeddedFileUrls.length > 0 && embeddedFileUrls.every((url) => isImageFileName(chatFileName(url))));

  const openPicker = (anchor: HTMLButtonElement) => {
    reactionToggleRef.current = anchor;
    setReactionPickerOpen((open) => !open);
  };
  const showTools = !isPinned && !message.deletedAt && !message.delivery && Boolean(onReply || onSetReaction || (isOwn && (onEdit || onDelete)));
  const toolButton = "flex h-6 w-[26px] items-center justify-center rounded-[5px] text-[var(--sa-ink-2)] transition hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";
  const reactions = (message.reactions ?? []).filter((reaction) => reaction.userIds.length > 0);

  return (
    <div
      id={`chat-message-${message.id}`}
      data-chat-message-id={message.id}
      data-kind={message.type}
      className={cn(
        "group/msg relative mx-1 grid min-w-0 grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 rounded-lg px-3 hover:bg-[var(--sa-surface-2)] focus-within:bg-[var(--sa-surface-2)]",
        grouped ? "py-0.5" : "pb-1.5 pt-2",
        isPinned && "hover:bg-transparent focus-within:bg-transparent",
      )}
    >
      <span aria-hidden="true" className="pt-0.5">
        {!grouped ? <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--sa-surface-3)] text-[11px] font-semibold tracking-[0.02em] text-[var(--sa-ink-2)]">{initials(message.senderName)}</span> : null}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {!grouped ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[13px] font-semibold text-board-text">{message.senderName}</span>
            {message.senderRole ? <span className="shrink-0 text-[11px] capitalize text-[var(--sa-ink-3)]">{message.senderRole}</span> : null}
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--sa-ink-3)]">{formatTimestamp(message.timestamp)}</span>
            {message.external?.platform ? <span className="shrink-0 text-[11px] capitalize text-[var(--sa-ink-3)]">{message.external.platform}</span> : null}
            {message.editedAt && !message.deletedAt ? <span className="shrink-0 text-[11px] text-[var(--sa-ink-3)]">edited</span> : null}
            {isSeen ? <span className="shrink-0 text-[11px] font-medium text-[var(--sa-ink-2)]">Seen</span> : null}
          </div>
        ) : (message.editedAt && !message.deletedAt) || isSeen ? (
          <p className="text-[11px] text-[var(--sa-ink-3)]">{[message.editedAt && !message.deletedAt ? "edited" : "", isSeen ? "Seen" : ""].filter(Boolean).join(" · ")}</p>
        ) : null}
        {isEvent ? (
          <div className={cn(
            "flex flex-col gap-1 rounded-lg border px-3 py-2.5",
            message.type === "alert" ? "border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10" : "border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.07]",
            isPinned && "ring-1 ring-[var(--sa-danger)]/35",
          )}>
            <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em]", message.type === "alert" ? "text-[var(--sa-danger)]" : "text-[var(--sa-warn)]")}>
              {message.type === "alert" ? <AlertTriangle className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
              {message.type}
            </span>
            <p className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.5] text-board-text", message.type === "alert" && "font-medium")}>{message.text}</p>
          </div>
        ) : (
          <div data-attachment-layout={containsOnlyImages ? "image-only" : undefined} className="min-w-0 max-w-full">
            {message.replyTo && (
              <div className="mb-1.5 flex min-w-0 max-w-full items-stretch gap-2 text-xs">
                <span className="w-0.5 shrink-0 rounded-full bg-[var(--sa-border-strong)]" />
                <div className="min-w-0 py-0.5">
                  <span className="font-semibold text-[var(--sa-ink-2)]">{message.replyTo.senderName}</span>
                  <p className="line-clamp-3 whitespace-pre-wrap text-[var(--sa-ink-3)] [overflow-wrap:anywhere]">{message.replyTo.text || "Attachment"}</p>
                </div>
              </div>
            )}
            {message.deletedAt ? (
              <p className="text-xs italic text-[var(--sa-ink-3)]">Message deleted</p>
            ) : displayText ? (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.5] text-board-text [overflow-wrap:anywhere]">{renderMessageText(displayText)}</p>
            ) : null}
            {!message.deletedAt && message.poll ? (
              <div className="mt-2 max-w-xl rounded-lg border border-[var(--sa-border-strong)] bg-board-bg p-3">
                <p className="text-xs font-semibold text-board-text">{message.poll.question}</p>
                <div className="mt-2 space-y-1.5">{message.poll.options.map((option) => {
                  const total = message.poll!.options.reduce((sum, item) => sum + item.voterIds.length, 0);
                  const selected = Boolean(currentUserId && option.voterIds.includes(currentUserId));
                  const percent = total ? Math.round(option.voterIds.length / total * 100) : 0;
                  return <button key={option.id} type="button" disabled={!onVotePoll || mutationPending} onClick={() => void onVotePoll?.(message.id, option.id, message.poll?.options.find(item => currentUserId && item.voterIds.includes(currentUserId))?.id ?? null)} className={cn("relative flex min-h-11 w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-xs transition disabled:opacity-50", selected ? "border-board-text/40 text-board-text" : "border-[var(--sa-border-strong)] text-board-text hover:border-[var(--sa-ink-3)]", !onVotePoll && "cursor-default")}><span className="absolute inset-y-0 left-0 bg-board-text/[0.08]" style={{ width: `${percent}%` }} /><span className="relative min-w-0 flex-1 truncate">{option.text}</span><span className="relative ml-2 tabular-nums text-[var(--sa-ink-3)]">{option.voterIds.length} · {percent}%</span></button>;
                })}</div>
                <p className="mt-2 text-[11px] text-[var(--sa-ink-3)]">{message.poll.options.reduce((sum, option) => sum + option.voterIds.length, 0)} votes</p>
              </div>
            ) : null}
            {!message.deletedAt && attachments.length ? (
              <div className={cn("grid w-full min-w-0 max-w-md gap-2", containsOnlyImages ? "mt-0" : "mt-2", attachments.length > 1 && "sm:grid-cols-2")}>
                {attachments.map((attachment) => attachment.mimeType.startsWith("image/") ? (
                  <button type="button" key={attachment.id} onClick={() => onOpenImage?.({ name: attachment.name, url: attachmentUrl(attachment.url) })} className="group/media relative block w-full overflow-hidden rounded-lg bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-400/70" aria-label={`Open ${attachment.name}`}>
                    <img src={attachmentUrl(attachment.url)} alt={attachment.name} loading="lazy" className="block max-h-72 w-full object-cover" />
                  </button>
                ) : (
                  <a key={attachment.id} href={attachmentUrl(attachment.url)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--sa-border-strong)] bg-board-bg p-2.5 transition hover:bg-[var(--sa-surface-2)]">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--sa-surface-3)] text-[var(--sa-ink-2)]"><FileText className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-board-text">{attachment.name}</span><span className="text-[11px] text-[var(--sa-ink-3)]">{formatFileSize(attachment.size)}</span></span>
                    <Download className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" />
                  </a>
                ))}
              </div>
            ) : null}
            {!message.deletedAt && embeddedFileUrls.length ? (
              <div className={cn("grid w-full min-w-0 max-w-md gap-2", containsOnlyImages ? "mt-0" : "mt-2", embeddedFileUrls.length > 1 && "sm:grid-cols-2")}>
                {embeddedFileUrls.map((url) => {
                  const name = chatFileName(url);
                  const resolvedUrl = attachmentUrl(url);
                  return isImageFileName(name) ? (
                    <button type="button" key={url} onClick={() => onOpenImage?.({ name, url: resolvedUrl })} className="group/media relative block w-full overflow-hidden rounded-lg bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-400/70" aria-label={`Open ${name}`}>
                      <img src={resolvedUrl} alt={name} loading="lazy" className="block max-h-72 w-full object-cover" />
                    </button>
                  ) : (
                    <a key={url} href={resolvedUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--sa-border-strong)] bg-board-bg p-2.5 transition hover:bg-[var(--sa-surface-2)]">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--sa-surface-3)] text-[var(--sa-ink-2)]"><FileText className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-board-text">{name}</span><span className="text-[11px] text-[var(--sa-ink-3)]">ShowPilot attachment</span></span>
                      <Download className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" />
                    </a>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
        {!message.deletedAt && onSetReaction && (reactions.length > 0 || showTools) ? (
          <div className={cn("mt-0.5 flex flex-wrap items-center gap-1", reactions.length === 0 && "hidden group-hover/msg:flex group-focus-within/msg:flex")}>
            {reactions.map((reaction) => {
              const emoji = reaction.emoji;
              const active = Boolean(currentUserId && reaction.userIds.includes(currentUserId));
              return <button key={emoji} type="button" disabled={mutationPending} onClick={() => void onSetReaction(message.id, emoji, !active)} aria-pressed={active} aria-label={`React ${emoji}`}
                className={cn("inline-flex h-6 items-center gap-[5px] rounded-full border pl-[7px] pr-2 text-xs transition focus-visible:outline-2 focus-visible:outline-[var(--sa-ink-2)] disabled:opacity-50 [@media(pointer:coarse)]:h-9",
                  active ? "border-board-text/40 bg-board-text/[0.13] text-board-text" : "border-[var(--sa-border-strong)] bg-[var(--sa-surface)] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text")}>
                <span>{emoji}</span><span className={cn("text-[11px] tabular-nums", active && "font-semibold")}>{reaction.userIds.length}</span>
              </button>;
            })}
            {showTools ? <button type="button" disabled={mutationPending} onClick={(event) => openPicker(event.currentTarget)} aria-label="Add reaction" className="hidden h-6 w-[30px] items-center justify-center rounded-full border border-dashed border-[var(--sa-border-strong)] text-[var(--sa-ink-3)] hover:border-solid hover:text-board-text group-hover/msg:inline-flex group-focus-within/msg:inline-flex [@media(pointer:coarse)]:h-9"><SmilePlus className="h-3.5 w-3.5" /></button> : null}
          </div>
        ) : null}
        <ExternalDeliveryStatus delivery={message.externalDelivery} />
        {message.delivery ? <div role={message.delivery === "failed" ? "alert" : "status"} className={cn("flex flex-wrap items-center gap-2 text-xs", message.delivery === "failed" ? "text-[var(--sa-danger)]" : "text-[var(--sa-ink-3)]")}><span>{message.delivery === "waiting" ? <QuietActivity label="Waiting for connection" /> : message.delivery === "sending" ? <QuietActivity label="Sending…" /> : plainFailure(message.deliveryError ?? "Message could not be sent.")}</span>{message.delivery === "failed" && onRetryQueued ? <button type="button" onClick={() => onRetryQueued(message.id)} className="min-h-11 rounded-lg border border-[var(--sa-border-strong)] px-3 font-semibold text-board-text hover:bg-[var(--sa-surface-2)]">Retry send</button> : null}{onCancelQueued ? <button type="button" onClick={() => onCancelQueued(message.id)} className="min-h-11 rounded-lg border border-[var(--sa-border-strong)] px-3 text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text">Remove local copy</button> : null}</div> : null}
      </div>
      {showTools ? (
        <div className="absolute -top-3 right-2.5 z-10 hidden gap-0.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0.5 shadow-[0_6px_16px_rgba(0,0,0,0.4)] group-hover/msg:flex group-focus-within/msg:flex [@media(hover:none)]:static [@media(hover:none)]:col-start-2 [@media(hover:none)]:mt-1 [@media(hover:none)]:flex [@media(hover:none)]:w-fit">
          {onReply && <button type="button" onClick={() => onReply(message)} className={toolButton} aria-label={`Reply to ${message.senderName}`} title="Reply"><Reply className="h-3.5 w-3.5" /></button>}
          {onSetReaction && <button type="button" disabled={mutationPending} onClick={(event) => openPicker(event.currentTarget)} className={toolButton} aria-label="Choose reaction" title="Choose reaction"><Smile className="h-3.5 w-3.5" /></button>}
          {isOwn && onEdit && <button type="button" disabled={mutationPending} onClick={() => onEdit(message)} className={toolButton} aria-label="Edit message" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>}
          {isOwn && onDelete && <button type="button" disabled={mutationPending} onClick={() => onDelete(message)} className={cn(toolButton, "hover:bg-[var(--sa-danger)]/10 hover:text-[var(--sa-danger)]")} aria-label="Delete message" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
        </div>
      ) : null}
      {reactionPickerOpen && createPortal(<div ref={reactionPickerRef} data-testid="reaction-picker" style={{ position: "fixed", ...reactionPosition }} className="schedule-a fixed z-50 w-[min(17rem,calc(100vw-2rem))] rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-2 shadow-xl">
        <div className="grid max-h-60 grid-cols-5 gap-1 overflow-y-auto">{MESSAGE_REACTIONS.map((emoji) => <button key={emoji} type="button" disabled={mutationPending} onClick={() => { setReactionPickerOpen(false); void onSetReaction?.(message.id, emoji, !message.reactions?.some(item => item.emoji === emoji && currentUserId && item.userIds.includes(currentUserId))); }} className="min-h-11 min-w-11 rounded-md p-1.5 text-base hover:bg-[var(--sa-surface-2)] disabled:opacity-50" aria-label={`React ${emoji}`}>{emoji}</button>)}</div>
        <form className="mt-2 flex gap-1 border-t border-[var(--sa-border)] pt-2" onSubmit={(event) => { event.preventDefault(); if (mutationPending || !isEmojiReaction(customReaction)) return; setReactionPickerOpen(false); setCustomReaction(""); void onSetReaction?.(message.id, customReaction, !message.reactions?.some(item => item.emoji === customReaction && currentUserId && item.userIds.includes(currentUserId))); }}>
          <input aria-label="Type or paste any emoji" value={customReaction} onChange={(event) => setCustomReaction(event.target.value)} maxLength={32} placeholder="Any emoji" className="min-h-11 min-w-0 flex-1 rounded-md border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2 py-1 text-xs text-board-text outline-none focus:border-fire-500" />
          <button type="submit" disabled={mutationPending || !isEmojiReaction(customReaction)} className="min-h-11 min-w-11 rounded-md bg-fire-500 px-2 text-xs font-semibold text-[#1a1300] disabled:opacity-40">Add</button>
        </form>
      </div>, document.body)}
    </div>
  );
}

function renderMessageText(text: string): ReactNode {
  const parts = text.split(/(@[\p{L}\p{N}][\p{L}\p{N}._'’-]*)/gu);
  return parts.map((part, index) => part.startsWith("@")
    ? <span key={`${part}-${index}`} className="rounded bg-sky-400/10 px-1 py-0.5 font-medium text-sky-300">{part}</span>
    : part);
}

function chatFileName(url: string): string {
  const value = url.split("?")[0].split("/").pop() || "Attachment";
  try { return decodeURIComponent(value); } catch { return value; }
}

function isImageFileName(name: string): boolean {
  return /\.(?:jpe?g|png|webp|gif|avif)$/i.test(name);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// -- Main ChatPanel --

interface ChatPanelProps {
  messages: ChatMessage[];
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  onSendMessage: (text: string, type: MessageType, options?: ChatMessageOptions) => void | Promise<void>;
  attachmentDraft?: WebChatAttachmentDraft;
  composer: WebChatComposer;
  onEditMessage?: (messageId: string, text: string, expectedEditTime: number) => Promise<void>;
  onDeleteMessage?: (messageId: string, expectedEditTime: number) => Promise<void>;
  mentionMembers?: ChatMemberSummary[];
  onClose?: () => void;
  className?: string;
  title?: string;
  subtitle?: string;
  currentUserName?: string;
  currentUserId?: string;
  liveStatus?: string | null;
  allowOperationalMessages?: boolean;
  headerActions?: ReactNode;
  attachmentAccessToken?: string;
  typingUsers?: ChatTypingState[];
  onTypingChange?: (typing: boolean) => void;
  seenThrough?: number;
  onVotePoll?: (messageId: string, optionId: string, expectedOptionId: string | null) => Promise<void>;
  onSetReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  focusedMessageId?: string;
  gatewayStatus?: ChatGatewayStatus;
  hydrated?: boolean;
  connectionUpdatedAt?: number;
  onReconnect?: () => void;
  onReadThrough?: (readAt: number) => void;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  olderMessagesError?: string | null;
  onLoadOlderMessages?: () => Promise<void>;
  mutations?: ChatMutationWork[];
  onRetryMutation?: (requestId: string) => void;
  onDismissMutation?: (requestId: string) => void;
  notifications?: ChatNotificationWork[];
  onRetryNotifications?: (requestId: string) => void;
  onRetryQueuedMessage?: (messageId: string) => void;
  onCancelQueuedMessage?: (messageId: string) => void;
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
  currentUserId,
  liveStatus,
  allowOperationalMessages = true,
  headerActions,
  attachmentDraft,
  composer,
  attachmentAccessToken,
  onEditMessage,
  onDeleteMessage,
  mentionMembers = [],
  typingUsers = [],
  onTypingChange,
  seenThrough,
  onVotePoll,
  onSetReaction,
  focusedMessageId,
  gatewayStatus,
  hydrated = true,
  connectionUpdatedAt: _connectionUpdatedAt,
  onReconnect,
  onReadThrough,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  olderMessagesError,
  onLoadOlderMessages,
  mutations = [],
  onRetryMutation,
  onDismissMutation,
  notifications = [],
  onRetryNotifications,
  onRetryQueuedMessage,
  onCancelQueuedMessage,
}: ChatPanelProps) {
  const composerSnapshot = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot);
  const { text: inputText, messageType, replyingTo, editing: editingMessage, pollOpen, pollQuestion, pollOptions } = composerFields(composerSnapshot);
  const { setText: setInputText, setMessageType, setReplyingTo, setPollQuestion, setPollOptions, setPollOpen } = composer;
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [openImage, setOpenImage] = useState<{ name: string; url: string } | null>(null);
  const attachmentWork = useSyncExternalStore(attachmentDraft?.subscribe ?? noAttachmentSubscription, attachmentDraft?.getSnapshot ?? emptyAttachmentSnapshot, emptyAttachmentSnapshot);
  const pendingAttachments = attachmentWork.flatMap(work => work.state === "ready" ? [work.attachment] : []);
  const attachmentsBlocked = attachmentWork.some(work => work.state !== "ready");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [messageActionError, setMessageActionError] = useState<string | null>(null);
  const blockedMessages = new Set(mutations.filter(item => item.state !== "settled" || item.result.cleanup !== "complete").map(item => item.command.messageId));
  const voteSafely: NonNullable<ChatPanelProps["onVotePoll"]> = async (...args) => {
    try { await onVotePoll?.(...args); setMessageActionError(null); }
    catch (error) { setMessageActionError(error instanceof ChatMutationTrackedError ? null : error instanceof Error ? error.message : "That change could not be made. Try again."); }
  };
  const reactSafely: NonNullable<ChatPanelProps["onSetReaction"]> = async (...args) => {
    try { await onSetReaction?.(...args); setMessageActionError(null); }
    catch (error) { setMessageActionError(error instanceof ChatMutationTrackedError ? null : error instanceof Error ? error.message : "That change could not be made. Try again."); }
  };
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const initialPositionDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const scrollLayoutRef = useRef({ width: 0, height: 0, contentHeight: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const pinTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedAtRef = useRef(Date.now());
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();


  useEffect(() => {
    if (!focusedMessageId) return;
    const target = document.getElementById(`chat-message-${focusedMessageId}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (hasOlderMessages && !loadingOlderMessages) void onLoadOlderMessages?.();
  }, [focusedMessageId, hasOlderMessages, loadingOlderMessages, messages, onLoadOlderMessages]);

  const loadOlder = async () => {
    if (!onLoadOlderMessages || loadingOlderMessages) return;
    const container = scrollContainerRef.current;
    const priorHeight = container?.scrollHeight ?? 0;
    const priorTop = container?.scrollTop ?? 0;
    await onLoadOlderMessages();
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollTop = priorTop + (container.scrollHeight - priorHeight);
    });
  };

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

  const markLatestRead = useCallback(() => {
    const latestTimestamp = messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
    if (latestTimestamp) onReadThrough?.(latestTimestamp);
  }, [messages, onReadThrough]);

  // A conversation always opens at the latest message. Focused message links
  // are the only exception and are handled by the effect above.
  useEffect(() => {
    if (messages.length === 0) {
      initialPositionDoneRef.current = false;
      stickToBottomRef.current = true;
      return;
    }
    if (!hydrated) return;
    if (focusedMessageId || (initialPositionDoneRef.current && !stickToBottomRef.current)) return;
    const frame = requestAnimationFrame(() => {
      if (!scrollContainerRef.current?.clientHeight) return;
      messagesEndRef.current?.scrollIntoView({ block: "end" });
      initialPositionDoneRef.current = true;
      stickToBottomRef.current = true;
      setShowScrollButton(false);
      markLatestRead();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedMessageId, hydrated, markLatestRead, messages, pinnedIds.size]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = messagesContentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const wasHidden = scrollLayoutRef.current.height === 0;
      scrollLayoutRef.current = {
        width: container.clientWidth,
        height: container.clientHeight,
        contentHeight: container.scrollHeight,
      };
      if (container.clientHeight === 0) return;
      // Show Flow keeps its chat mounted while switching tabs. Opening that
      // hidden panel is a new opening, not a request to restore an old offset.
      if (wasHidden) stickToBottomRef.current = true;
      if (hydrated && !focusedMessageId && stickToBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ block: "end" });
        initialPositionDoneRef.current = true;
        setShowScrollButton(false);
        markLatestRead();
      }
    });
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [focusedMessageId, hydrated, markLatestRead]);

  // Detect if user has scrolled up
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const layout = scrollLayoutRef.current;
    // Browser scroll anchoring can fire before ResizeObserver after wrapping,
    // image loading or panel resizing. It must not count as scrolling away.
    if (container.clientWidth !== layout.width
      || container.clientHeight !== layout.height
      || container.scrollHeight !== layout.contentHeight) return;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    stickToBottomRef.current = isAtBottom;
    setShowScrollButton(!isAtBottom);
    if (isAtBottom) markLatestRead();
  };

  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollButton(false);
    markLatestRead();
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

  const handleSend = async () => {
    if ((!editingMessage && attachmentsBlocked) || (!inputText.trim() && pendingAttachments.length === 0)) return;
    onTypingChange?.(false);
    try {
      await composer.send("message", async snapshot => {
        if (snapshot.edit) {
          if (!onEditMessage || !snapshot.edit.text.trim()) throw new Error("Enter text to save this edit.");
          await onEditMessage(snapshot.edit.target.id, snapshot.edit.text.trim(), chatEditTime(snapshot.edit.target));
          return;
        }
        const { text, messageType: type, replyingTo: reply } = snapshot.message;
        const enqueue = (attachments: typeof pendingAttachments) => onSendMessage(text.trim(), type, {
          replyTo: reply ? { messageId: reply.id, senderName: reply.senderName, text: reply.text } : undefined,
          attachments: attachments.length ? attachments : undefined,
          mentionedUserIds: mentionedUserIds(text, mentionMembers),
        });
        if (attachmentDraft) await attachmentDraft.handoff(enqueue); else await enqueue([]);
      });
      setMessageActionError(null);
    } catch (error) {
      setMessageActionError(error instanceof ChatMutationTrackedError ? null : error instanceof Error ? error.message : "Your message could not be sent. Your draft is still here — try sending again.");
    }
  };

  const sendPoll = async () => {
    if (!pollQuestion.trim() || pollOptions.filter(text => text.trim()).length < 2) return;
    try {
      await composer.send("poll", snapshot => onSendMessage("", "text", { poll: {
        question: snapshot.poll.question.trim(),
        options: snapshot.poll.options.map(text => text.trim()).filter(Boolean).map(text => ({ id: "", text, voterIds: [] })),
      } }));
      setMessageActionError(null);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Your poll could not be sent. Try sending it again.");
    }
  };

  useEffect(() => {
    if (!onTypingChange) return;
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    const isTyping = inputText.trim().length > 0;
    onTypingChange(isTyping);
    if (isTyping) typingTimeoutRef.current = setTimeout(() => onTypingChange(false), 1600);
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [inputText, onTypingChange]);

  useEffect(() => () => onTypingChange?.(false), [onTypingChange]);

  const beginEdit = (message: ChatMessage) => {
    composer.beginEdit(message);
    textareaRef.current?.focus();
  };

  const removeQueuedMessage = async (id: string) => {
    if (await confirm({ title: "Remove this queued copy?", description: "This removes the local copy only. If the server already accepted the message, it may still appear in the conversation.", confirmLabel: "Remove local copy", variant: "warning" })) onCancelQueuedMessage?.(id);
  };

  const deleteMessage = async (message: ChatMessage) => {
    if (!onDeleteMessage) return;
    const confirmed = await confirm({
      title: "Delete message?",
      description: "Everyone in this room will see that the message was deleted. This cannot be undone.",
      confirmLabel: "Delete message",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await onDeleteMessage(message.id, chatEditTime(message));
      setMessageActionError(null);
    } catch (error) {
      setMessageActionError(error instanceof ChatMutationTrackedError ? null : error instanceof Error ? error.message : "Could not delete message");
    }
  };

  const mentionQuery = mentionSearch(inputText);
  const mentionSuggestions = mentionQuery === null ? [] : mentionMembers
    .filter((member) => member.name.toLowerCase().includes(mentionQuery))
    .slice(0, 5);

  const insertMention = (member: ChatMemberSummary) => {
    setInputText((current) => insertMentionText(current, member.name));
    textareaRef.current?.focus();
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!attachmentDraft || files.length === 0) return;
    setUploadError(null);
    for (const file of files) {
      try { attachmentDraft.add(file, file.name); }
      catch (error) { setUploadError(error instanceof Error ? error.message : "Attachment could not be added"); break; }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const resize = () => {
      if (ta.clientWidth === 0) return;
      ta.style.height = "auto";
      ta.style.height = `${Math.max(44, Math.min(ta.scrollHeight, 120))}px`;
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    let width = ta.clientWidth;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (ta.clientWidth === width) return;
      width = ta.clientWidth;
      // Writing the observed height during delivery creates a ResizeObserver
      // loop error. Coalesce width changes outside that delivery frame.
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = undefined; resize(); });
    });
    observer.observe(ta);
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [inputText]);

  // Separate pinned alerts from regular messages
  const pinnedAlerts = messages.filter((m) => pinnedIds.has(m.id));
  const latestSystemUpdate = messages.reduce<ChatMessage | null>(
    (latest, message) => message.type === "system" && (!latest || message.timestamp > latest.timestamp) ? message : latest,
    null,
  );
  // `undefined` means this surface has no direct rundown state and may use
  // chat automation as a fallback. `null` explicitly means the show is stopped.
  const hasDirectLiveState = liveStatus !== undefined;
  const dockedLiveStatus = hasDirectLiveState
    ? liveStatus?.trim() || null
    : latestSystemUpdate?.text.replace(/^Now live:\s*/i, "") || null;
  const dockedLiveTimestamp = hasDirectLiveState ? null : latestSystemUpdate?.timestamp;
  // Pinning changes prominence, not history. Alerts remain readable in
  // the timeline after their urgent ten-second treatment ends. Automated
  // rundown status belongs in the header dock, not the conversation.
  const conversationMessages = useMemo(() => messages.filter((message) => message.type !== "system"), [messages]);
  const displayMessages = conversationMessages.filter((message) => !pinnedIds.has(message.id));
  const latestSeenOwnMessageId = seenThrough === undefined ? undefined : [...conversationMessages]
    .reverse()
    .find((message) => !message.deletedAt && (currentUserId ? message.senderId === currentUserId : currentUserName && message.senderName === currentUserName) && message.timestamp <= seenThrough)?.id;

  const beginReply = (message: ChatMessage) => {
    setReplyingTo(message);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const gatewaySummary = gatewayStatus?.status === "error" && gatewayStatus.platform
    ? `${gatewayStatus.platform[0].toUpperCase()}${gatewayStatus.platform.slice(1)} is not connected`
    : null;

  return (
    <div
      data-testid="chat-panel"
      className={cn(
        "schedule-a relative flex h-full w-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-[var(--sa-surface)]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--sa-border)] pl-4 pr-3">
        <div className="flex min-w-0 items-center gap-2">
          <Hash className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" />
          <span className="truncate text-[13px] font-semibold text-board-text">{title}</span>
          {unreadCount > 0 && <span className="rounded-full bg-fire-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-[#1a1300]">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {dockedLiveStatus && (
            <span className="hidden min-w-0 items-center gap-2 text-xs sm:flex" title={dockedLiveStatus}>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sa-ok)] shadow-[0_0_0_3px_rgba(62,207,142,0.18)]" />
              <span className="shrink-0 font-medium text-board-text">Now live</span>
              <span className="truncate text-[var(--sa-ink-3)]">{dockedLiveStatus}</span>
              {dockedLiveTimestamp && <span className="shrink-0 tabular-nums text-[var(--sa-ink-3)]">{formatTimestamp(dockedLiveTimestamp)}</span>}
            </span>
          )}
          {subtitle || gatewaySummary ? (
            <p className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs", gatewayStatus?.status === "error" ? "text-[var(--sa-danger)]" : "text-[var(--sa-ink-3)]")} title={gatewayStatus?.error}><ConnectionDot status={connectionStatus} />{subtitle}{gatewaySummary ? ` · ${gatewaySummary}` : ""}</p>
          ) : null}
          {headerActions && <div className="flex shrink-0 items-center">{headerActions}</div>}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chat"
              title="Close chat"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sa-ink-3)] transition-colors hover:bg-[var(--sa-surface-2)] hover:text-board-text"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {dockedLiveStatus && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--sa-border)] px-4 py-2 text-xs sm:hidden">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sa-ok)]" />
          <span className="font-medium text-board-text">Now live</span>
          <span className="min-w-0 flex-1 truncate text-[var(--sa-ink-3)]">{dockedLiveStatus}</span>
          {dockedLiveTimestamp && <span className="tabular-nums text-[var(--sa-ink-3)]">{formatTimestamp(dockedLiveTimestamp)}</span>}
        </div>
      )}

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
        data-testid="chat-scroll-region"
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-2 modern-scrollbar"
      >
        <div ref={messagesContentRef}>
          {connectionStatus === "error" && <div role="alert" className="space-y-2 border-b border-board-border px-4 py-3 text-xs text-amber-200">
            <p>Chat is offline.</p>
            {onReconnect && <button type="button" onClick={onReconnect} className="min-h-11 rounded-lg border border-board-border px-3">Retry chat</button>}
          </div>}
          {(hasOlderMessages || loadingOlderMessages || olderMessagesError) && (
            <div className="flex flex-col items-center gap-1 px-4 py-2">
              {(hasOlderMessages || loadingOlderMessages) && <button type="button" onClick={() => void loadOlder()} disabled={loadingOlderMessages} className="min-h-9 rounded-full border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 py-1 text-xs font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-50 [@media(pointer:coarse)]:min-h-11" aria-label={loadingOlderMessages ? "Loading older messages…" : olderMessagesError ? "Retry older messages" : "Load older messages"}>{loadingOlderMessages ? <QuietActivity label="Loading older messages…" /> : olderMessagesError ? "Retry older messages" : "Load older messages"}</button>}
              {olderMessagesError && <p role="alert" className="text-[10px] text-red-300">{plainFailure(olderMessagesError)}</p>}
            </div>
          )}
          {displayMessages.length === 0 && hydrated && connectionStatus === "connected" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><MessageSquare className="h-4 w-4" /></span>
              <p className="text-sm font-semibold text-board-text">No messages yet</p>
              <p className="max-w-[340px] text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">
                {pinnedAlerts.length > 0
                  ? "Only active alerts are showing right now."
                  : allowOperationalMessages
                    ? "Use Cue to call the next item and Alert for anything urgent. Everyone in this chat sees them."
                    : "Messages from the production team will appear here."}
              </p>
            </div>
          )}

          {displayMessages.map((msg, index) => {
          const previous = displayMessages[index - 1];
          const showDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
          const grouped = Boolean(
            previous &&
            previous.senderName === msg.senderName &&
            previous.senderRole === msg.senderRole &&
            previous.type === msg.type &&
            msg.timestamp - previous.timestamp < 5 * 60 * 1000,
          );
          return (
            <div key={msg.id}>
              {showDay && (
                <div className="my-2 flex items-center gap-2.5 px-4" role="separator">
                  <span className="h-px flex-1 bg-[var(--sa-border)]" />
                  <span className="text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">{formatDay(msg.timestamp)}</span>
                  <span className="h-px flex-1 bg-[var(--sa-border)]" />
                </div>
              )}
              <ChatMessageRow message={msg} grouped={grouped} isOwn={Boolean(currentUserId ? msg.senderId === currentUserId : currentUserName && msg.senderName === currentUserName)} onReply={beginReply} onEdit={onEditMessage ? beginEdit : undefined} onDelete={onDeleteMessage ? deleteMessage : undefined} attachmentAccessToken={attachmentAccessToken} isSeen={msg.id === latestSeenOwnMessageId} currentUserId={currentUserId} mutationPending={blockedMessages.has(msg.id)} onVotePoll={onVotePoll ? voteSafely : undefined} onSetReaction={onSetReaction ? reactSafely : undefined} onOpenImage={setOpenImage} onRetryQueued={onRetryQueuedMessage} onCancelQueued={onCancelQueuedMessage ? id => void removeQueuedMessage(id) : undefined} />
            </div>
          );
          })}
          {typingUsers.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 text-[10px] text-board-muted" aria-live="polite">
              <span className="flex gap-0.5" aria-hidden="true"><span className="h-1 w-1 animate-bounce rounded-full bg-sky-300" /><span className="h-1 w-1 animate-bounce rounded-full bg-sky-300 [animation-delay:120ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-sky-300 [animation-delay:240ms]" /></span>
              <span>{typingUsers.length === 1 ? `${typingUsers[0].name} is typing…` : `${typingUsers.slice(0, 2).map((user) => user.name).join(" and ")} are typing…`}</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
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

      {(pollOpen || mutations.some(item => item.state === "unknown" || item.state === "settled" && (item.result.outcome !== "applied" || item.result.cleanup !== "complete")) || notifications.some(item => item.status === "failed") || (attachmentWork.length > 0 && !editingMessage)) && <div aria-label="Chat recovery" className={cn("min-h-20 shrink overflow-x-hidden overflow-y-auto", pollOpen ? "max-h-[50%]" : "max-h-48")}>
      {pollOpen && <section aria-label="Poll draft" className="space-y-2 rounded-xl border border-board-border bg-board-card p-3">
        <div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-sky-300" /><p className="text-sm font-semibold text-board-text">Create a poll</p><button type="button" onClick={() => setPollOpen(false)} className="ml-auto min-h-11 min-w-11 text-board-muted" aria-label="Close poll composer"><X className="mx-auto h-4 w-4" /></button></div>
        <label className="block text-xs text-board-muted">Question<input maxLength={240} value={pollQuestion} onChange={event => setPollQuestion(event.target.value)} placeholder="Ask a question" className="mt-1 min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text" /></label>
        {pollOptions.map((option, index) => <label key={index} className="block text-xs text-board-muted">Option {index + 1}<input maxLength={120} value={option} onChange={event => setPollOptions(items => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`Option ${index + 1}`} className="mt-1 min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm text-board-text" /></label>)}
        <div className="flex items-center gap-2"><button type="button" disabled={pollOptions.length >= 6} onClick={() => setPollOptions(items => [...items, ""])} className="flex min-h-11 items-center gap-1 text-xs text-board-muted"><Plus className="h-3 w-3" />Add option</button><button type="button" disabled={!pollQuestion.trim() || pollOptions.filter(item => item.trim()).length < 2} onClick={sendPoll} className="ml-auto min-h-11 rounded-lg bg-sky-400 px-3 text-xs font-semibold text-black disabled:opacity-40">Send poll</button></div>
      </section>}
      {mutations.some(item => item.state === "unknown" || item.state === "settled" && (item.result.outcome !== "applied" || item.result.cleanup !== "complete")) && <section aria-label="Message changes" className="border-t border-board-border">
        {mutations.filter(item => item.state === "unknown" || item.state === "settled" && (item.result.outcome !== "applied" || item.result.cleanup !== "complete")).map(item => <div key={item.command.requestId} hidden={item.state === "sending"} role={item.state === "sending" ? "status" : "alert"} className="space-y-2 border-b border-board-border px-4 py-3 text-sm text-amber-200">
          <p className="break-words">{item.state === "sending" ? <QuietActivity label="Saving message change…" /> : item.state === "unknown" ? item.error : item.result.cleanup !== "complete" ? "The message was deleted, but its attachments were not removed. Retry attachment cleanup to finish removing them." : plainFailure(chatMutationOutcomeMessage(item.result))}</p>
          <p className="break-words text-xs text-board-muted">{chatMutationSummary(item.command.operation).slice(0, 140)}</p>

          {item.state !== "sending" && (item.state === "unknown" || item.result.cleanup !== "complete") && onRetryMutation && <button type="button" disabled={connectionStatus !== "connected"} className="ml-2 min-h-11 rounded-lg border border-board-border px-3 disabled:opacity-50" onClick={() => onRetryMutation(item.command.requestId)}>{item.state === "settled" ? "Retry attachment cleanup" : "Recover original change"}</button>}
          {item.state === "settled" && item.result.cleanup === "complete" && onDismissMutation && <button type="button" className="ml-2 min-h-11 rounded-lg border border-board-border px-3" onClick={() => onDismissMutation(item.command.requestId)}>Dismiss result</button>}
        </div>)}
      </section>}

      {notifications.some(item => item.status === "failed") && <section aria-label="Crew notification delivery" className="border-t border-board-border">
          {notifications.map(item => <div key={item.command.requestId} hidden={item.status === "pending"} role={item.status === "failed" ? "alert" : "status"} className="space-y-2 border-b border-board-border px-4 py-3 text-sm text-amber-200">
            <p className="break-words">Crew alerts could not be sent.</p>
            <p className="break-words text-xs text-board-muted">{item.label.slice(0, 120)}</p>

            {item.status === "failed" && onRetryNotifications && <button type="button" className="ml-2 min-h-11 rounded-lg border border-board-border px-3" onClick={() => onRetryNotifications(item.command.requestId)}>Retry notifications</button>}
          </div>)}
      </section>}

          {attachmentWork.length > 0 && !editingMessage && (
            <div className="border-b border-board-border/70 px-3 py-2" aria-label="Draft attachments">
              {attachmentWork.map(work => (
                <div key={work.id} data-testid={`chat-attachment-${work.id}`} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-board-border bg-board-card p-2 text-xs">
                  <FileText className="h-4 w-4 shrink-0 text-fire-300" />
                  <div className="min-w-0 flex-1"><p className="break-all text-board-text">{work.name}</p><p className="text-board-muted">{["uploading", "removing", "sending"].includes(work.state) ? <QuietActivity label={attachmentStateLabel(work)} /> : null}</p></div>
                  {(work.state === "upload-failed" || work.state === "remove-failed") && <p role="alert" className="w-full break-words text-red-300">{work.state === "upload-failed" ? "This attachment did not finish uploading." : "This attachment could not be removed."}</p>}
                  {(work.state === "upload-failed" || work.state === "remove-failed") && <button type="button" className="min-h-11 rounded-lg border border-board-border px-3 text-board-text" aria-label={`${work.state === "remove-failed" ? "Retry removing" : "Retry uploading"} ${work.name}`} onClick={() => attachmentDraft?.retry(work.id)}>{work.state === "remove-failed" ? "Retry removal" : "Retry upload"}</button>}
                  {work.state !== "removing" && work.state !== "remove-failed" && work.state !== "sending" && <button type="button" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-board-border text-board-muted hover:text-board-text" aria-label={`Remove ${work.name}`} onClick={() => attachmentDraft?.remove(work.id)}><X className="h-4 w-4" /></button>}
                </div>
              ))}
            </div>
          )}
      </div>}

      {/* Input area */}
      <div className="min-w-0 shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">

        {mentionSuggestions.length > 0 && !editingMessage && (
          <div className="mb-2 overflow-hidden rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] shadow-xl">
            <div className="flex items-center gap-2 border-b border-[var(--sa-border)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]"><AtSign className="h-3 w-3" />Mention someone</div>
            {mentionSuggestions.map((member) => <button key={member.userId} type="button" onClick={() => insertMention(member)} className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--sa-surface-2)]"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--sa-surface-3)] text-[11px] font-semibold text-[var(--sa-ink-2)]">{initials(member.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-board-text">{member.name}</span><span className="block text-[11px] capitalize text-[var(--sa-ink-3)]">{member.role}</span></span></button>)}
          </div>
        )}
        <div className={cn(
          "overflow-hidden rounded-xl border bg-board-bg transition",
          messageType === "cue" && !editingMessage ? "border-[var(--sa-warn)]/35" : messageType === "alert" && !editingMessage ? "border-[var(--sa-danger)]/35" : "border-[var(--sa-border)] focus-within:border-[var(--sa-border-strong)]",
        )}>
          {editingMessage && <div className="flex items-center gap-3 border-b border-[var(--sa-border)] px-3 py-2"><Pencil className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /><div className="min-w-0 flex-1"><p className="text-xs font-semibold text-board-text">Editing message</p><p className="truncate text-xs text-[var(--sa-ink-3)]">Changes update for everyone in this room.</p></div><button type="button" onClick={composer.cancelEdit} className="flex min-h-11 min-w-11 items-center justify-center rounded text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text" aria-label="Cancel edit"><X className="h-3.5 w-3.5" /></button></div>}
          {replyingTo && (
            <div className="flex items-center gap-3 border-b border-[var(--sa-border)] px-3 py-2">
              <Reply className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-board-text">Replying to {replyingTo.senderName}</p><p className="truncate text-xs text-[var(--sa-ink-3)]">{replyingTo.text || "Attachment"}</p></div>
              <button type="button" onClick={() => setReplyingTo(null)} className="flex min-h-11 min-w-11 items-center justify-center rounded text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text" aria-label="Cancel reply"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <div className="flex min-h-11 items-center gap-2 py-1.5 pl-1.5 pr-1.5">
            {allowOperationalMessages && !editingMessage ? (
              <MessageTypeSelector value={messageType} onChange={setMessageType} />
            ) : (
              <span className="shrink-0 px-2 text-xs text-[var(--sa-ink-3)]">{editingMessage ? "Edit message" : "Guest message"}</span>
            )}
            <textarea
              ref={textareaRef}
              aria-label={`Message ${title}`}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                messageType === "cue"
                  ? "Call the next cue"
                  : messageType === "alert"
                    ? "Something urgent for the crew"
                    : `Message ${title.toLowerCase()}`
              }
              rows={1}
              className="min-h-8 min-w-0 flex-1 resize-none self-center bg-transparent px-1 py-1.5 text-base leading-5 text-board-text outline-none placeholder:text-[var(--sa-ink-3)] modern-scrollbar sm:text-[13px]"
            />
            {attachmentWork.length > 0 ? <span className="shrink-0 text-[11px] tabular-nums text-[var(--sa-ink-3)]">{attachmentWork.length}/6</span> : null}
            {onVotePoll && !editingMessage ? <button type="button" onClick={() => setPollOpen((open) => !open)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label="Create poll" title="Create poll"><BarChart3 className="h-4 w-4" /></button> : null}
            {attachmentDraft && !editingMessage && (
              <>
                <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={handleFiles} className="hidden" />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={attachmentWork.length >= 6} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--sa-ink-3)] transition hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label="Attach photos or documents" title="Attach photos or documents"><Paperclip className="h-4 w-4" /></button>
              </>
            )}
            <button
              type="button"
              onClick={handleSend}
              disabled={(!inputText.trim() && pendingAttachments.length === 0) || (!editingMessage && attachmentsBlocked) || Boolean(editingMessage && blockedMessages.has(editingMessage.id))}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors touch-manipulation [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
                (inputText.trim() || pendingAttachments.length > 0) && (editingMessage || !attachmentsBlocked)
                  ? "bg-fire-500 text-[#1a1300] hover:bg-fire-400"
                  : "cursor-not-allowed bg-[var(--sa-surface-2)] text-[var(--sa-ink-3)]",
              )}
              aria-label={editingMessage ? "Save message" : "Send message"}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
        {(uploadError || messageActionError) && <p role="alert" className="mt-1.5 px-1 text-sm text-[var(--sa-danger)]">{uploadError || messageActionError}</p>}
      </div>
      {openImage ? (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label={openImage.name}>
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-3">
            <button type="button" onClick={() => setOpenImage(null)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20" aria-label="Close image"><X className="h-5 w-5" /></button>
            <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-white/85">{openImage.name}</span>
            <a href={openImage.url} download={openImage.name} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20" aria-label="Download image"><Download className="h-4 w-4" /></a>
          </div>
          <button type="button" onClick={() => setOpenImage(null)} className="min-h-0 flex-1 cursor-zoom-out p-3" aria-label="Close image preview">
            <img src={openImage.url} alt={openImage.name} className="h-full w-full object-contain" />
          </button>
        </div>
      ) : null}
      {ConfirmDialogEl}
    </div>
  );
}

const noAttachmentWork: ChatAttachmentWork[] = [];
const emptyAttachmentSnapshot = () => noAttachmentWork;
const noAttachmentSubscription = () => () => {};
function attachmentStateLabel(work: ChatAttachmentWork): string {
  switch (work.state) {
    case "preparing": return "Preparing";
    case "uploading": return "Uploading";
    case "ready": return "Ready to send";
    case "sending": return "Adding to message";
    case "upload-failed": return "Upload not confirmed";
    case "removing": return "Removing";
    case "remove-failed": return "Removal not confirmed";
  }
}
