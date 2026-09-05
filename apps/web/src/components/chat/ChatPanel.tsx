import { useState, useRef, useEffect, useMemo, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
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
  Image as ImageIcon,
  Download,
  Loader2,
  Pencil,
  Trash2,
  AtSign,
  BarChart3,
  Plus,
  Smile,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ChatAttachment, ChatGatewayStatus, ChatMessage, ChatMessageOptions, ChatTypingState, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import { getDepartment, DEPARTMENTS } from "@/types";
import type { ChatMemberSummary } from "@/lib/chat-collaboration";
import { insertMention as insertMentionText, mentionedUserIds, mentionSearch } from "@/lib/chat-mentions";

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
const MESSAGE_REACTIONS = [
  "👍", "👎", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏", "👏",
  "🙌", "💯", "✅", "❌", "⚠️", "👀", "🤔", "💡", "🚀", "🎬",
  "🎥", "🎤", "🎧", "🔊", "🔇", "⏱️", "📌", "🛠️", "🫡", "🤝",
] as const;

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
  onReply,
  onEdit,
  onDelete,
  attachmentAccessToken,
  isSeen = false,
  currentUserId,
  onVotePoll,
  onToggleReaction,
  isFocused = false,
  onOpenImage,
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
  onVotePoll?: (messageId: string, optionId: string) => Promise<void>;
  onToggleReaction?: (messageId: string, emoji: string) => Promise<void>;
  isFocused?: boolean;
  onOpenImage?: (image: { name: string; url: string }) => void;
}) {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
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

  if (isEvent) {
    return (
      <div id={`chat-message-${message.id}`} data-chat-message-id={message.id} className={cn("px-4", grouped ? "pt-1" : "pt-3", isFocused && "rounded-lg ring-2 ring-sky-400/50 ring-inset")}>
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
      id={`chat-message-${message.id}`}
      data-chat-message-id={message.id}
      className={cn(
        "group flex items-end gap-2 px-4",
        isOwn && "justify-end",
        grouped ? "py-0.5" : "pb-1 pt-2.5",
        isFocused && "rounded-lg bg-sky-400/[0.08] ring-2 ring-sky-400/50 ring-inset",
      )}
    >
      {!isOwn && !grouped && (
        <div className={cn("mb-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold shadow-sm", avatarStyle(message.senderName))}>
          {initials(message.senderName)}
        </div>
      )}
      {!isOwn && grouped && <span className="w-7 shrink-0" />}
      <div className={cn("relative flex min-w-0 max-w-[78%] flex-col", isOwn ? "items-end" : "items-start")}>
        {!grouped && !isOwn && (
          <div className="mb-1 flex min-w-0 items-center gap-2 px-2">
            <span className="truncate text-[11px] font-semibold text-board-muted">{message.senderName}</span>
            <RoleBadge role={message.senderRole} />
          </div>
        )}
        <div
          data-attachment-layout={containsOnlyImages ? "image-only" : undefined}
          className={cn(
            "min-w-12 overflow-hidden",
            containsOnlyImages
              ? "rounded-xl bg-transparent p-0 shadow-none"
              : isOwn
                ? "rounded-[18px] rounded-br-md bg-fire-500 px-3 py-2.5 text-black shadow-sm"
                : "rounded-[18px] rounded-bl-md border border-board-border/80 bg-board-bg/90 px-3 py-2.5 text-board-text shadow-sm",
          )}
        >
        {message.replyTo && (
          <div className={cn("mb-2 flex max-w-2xl items-stretch gap-2 rounded-lg px-2 py-1.5 text-[11px]", isOwn ? "bg-black/10" : "bg-white/[0.035]")}>
            <span className={cn("w-0.5 shrink-0 rounded-full", isOwn ? "bg-black/55" : "bg-fire-400/65")} />
            <div className="min-w-0 py-0.5">
              <span className={cn("font-semibold", isOwn ? "text-black/80" : "text-fire-300/90")}>{message.replyTo.senderName}</span>
              <p className={cn("truncate", isOwn ? "text-black/65" : "text-board-muted/75")}>{message.replyTo.text || "Attachment"}</p>
            </div>
          </div>
        )}
        {message.deletedAt ? (
          <p className={cn("text-[12px] italic", isOwn ? "text-black/60" : "text-board-muted/60")}>Message deleted</p>
        ) : displayText ? (
          <p className={cn("whitespace-pre-wrap break-words text-[13px] leading-[1.3rem]", isOwn ? "text-black" : "text-board-text/90")}>{renderMessageText(displayText)}</p>
        ) : null}
        {!message.deletedAt && message.poll ? (
          <div className="mt-2 max-w-xl rounded-xl border border-board-border bg-board-bg/45 p-3">
            <p className="text-xs font-semibold text-board-text">{message.poll.question}</p>
            <div className="mt-2 space-y-1.5">{message.poll.options.map((option) => {
              const total = message.poll!.options.reduce((sum, item) => sum + item.voterIds.length, 0);
              const selected = Boolean(currentUserId && option.voterIds.includes(currentUserId));
              const percent = total ? Math.round(option.voterIds.length / total * 100) : 0;
              return <button key={option.id} type="button" disabled={!onVotePoll} onClick={() => void onVotePoll?.(message.id, option.id)} className={cn("relative flex w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-[11px] transition", selected ? "border-sky-400/45 text-sky-200" : "border-board-border text-board-text hover:border-board-muted/50", !onVotePoll && "cursor-default")}><span className="absolute inset-y-0 left-0 bg-sky-400/10" style={{ width: `${percent}%` }} /><span className="relative min-w-0 flex-1 truncate">{option.text}</span><span className="relative ml-2 tabular-nums text-board-muted">{option.voterIds.length} · {percent}%</span></button>;
            })}</div>
            <p className="mt-2 text-[9px] text-board-muted">{message.poll.options.reduce((sum, option) => sum + option.voterIds.length, 0)} votes</p>
          </div>
        ) : null}
        {!message.deletedAt && attachments.length ? (
          <div className={cn("grid max-w-2xl gap-2", containsOnlyImages ? "mt-0" : "mt-2", attachments.length > 1 && "sm:grid-cols-2")}>
            {attachments.map((attachment) => attachment.mimeType.startsWith("image/") ? (
              <button type="button" key={attachment.id} onClick={() => onOpenImage?.({ name: attachment.name, url: attachmentUrl(attachment.url) })} className="group/media relative block w-full overflow-hidden rounded-xl bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-400/70" aria-label={`Open ${attachment.name}`}>
                <img src={attachmentUrl(attachment.url)} alt={attachment.name} loading="lazy" className="block max-h-72 w-full object-cover transition duration-300 group-hover/media:scale-[1.015]" />
              </button>
            ) : (
              <a key={attachment.id} href={attachmentUrl(attachment.url)} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-xl border border-board-border bg-board-bg/55 p-3 transition hover:border-fire-400/30 hover:bg-board-bg/80">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fire-500/10 text-fire-300"><FileText className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-board-text">{attachment.name}</span><span className="text-[10px] text-board-muted">{formatFileSize(attachment.size)}</span></span>
                <Download className="h-4 w-4 shrink-0 text-board-muted" />
              </a>
            ))}
          </div>
        ) : null}
        {!message.deletedAt && embeddedFileUrls.length ? (
          <div className={cn("grid max-w-2xl gap-2", containsOnlyImages ? "mt-0" : "mt-2", embeddedFileUrls.length > 1 && "sm:grid-cols-2")}>
            {embeddedFileUrls.map((url) => {
              const name = chatFileName(url);
              const resolvedUrl = attachmentUrl(url);
              return isImageFileName(name) ? (
                <button type="button" key={url} onClick={() => onOpenImage?.({ name, url: resolvedUrl })} className="group/media relative block w-full overflow-hidden rounded-xl bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-400/70" aria-label={`Open ${name}`}>
                  <img src={resolvedUrl} alt={name} loading="lazy" className="block max-h-72 w-full object-cover transition duration-300 group-hover/media:scale-[1.015]" />
                </button>
              ) : (
                <a key={url} href={resolvedUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-xl border border-board-border bg-board-bg/55 p-3 transition hover:border-fire-400/30 hover:bg-board-bg/80">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-fire-500/10 text-fire-300"><FileText className="h-5 w-5" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-board-text">{name}</span><span className="text-[10px] text-board-muted">ShowPilot attachment</span></span>
                  <Download className="h-4 w-4 shrink-0 text-board-muted" />
                </a>
              );
            })}
          </div>
        ) : null}
        </div>
        {!message.deletedAt && onToggleReaction ? (
          <div className={cn("mt-1 flex flex-wrap items-center gap-1", isOwn && "justify-end")}>
            {(message.reactions ?? []).filter((reaction) => reaction.userIds.length > 0).map((reaction) => {
              const emoji = reaction.emoji;
              const active = Boolean(currentUserId && reaction?.userIds.includes(currentUserId));
              return <button key={emoji} type="button" onClick={() => void onToggleReaction(message.id, emoji)} className={cn("rounded-full border px-1.5 py-0.5 text-[10px] transition", active ? "border-fire-500/40 bg-fire-500/10 text-board-text" : "border-board-border text-board-muted hover:text-board-text")} aria-label={`React ${emoji}`}>{emoji} {reaction.userIds.length}</button>;
            })}
          </div>
        ) : null}
        <div className={cn("mt-1 flex items-center gap-1.5 px-2 text-[9px] tabular-nums text-board-muted/55", isOwn && "justify-end")}>
          {message.external?.platform ? <span className="capitalize">{message.external.platform}</span> : null}
          <span>{formatTimestamp(message.timestamp)}</span>
          {message.editedAt && !message.deletedAt ? <span>· edited</span> : null}
          {isSeen ? <span className="font-medium text-sky-300/75">· Seen</span> : null}
        </div>
        {message.externalDelivery?.status === "pending" ? <p className={cn("mt-1 px-2 text-[9px] text-board-muted", isOwn && "text-right")}>Sending to {message.externalDelivery.platform}…</p> : null}
        {message.externalDelivery?.status === "failed" ? <p className={cn("mt-1 px-2 text-[9px] text-red-300", isOwn && "text-right")}>Not delivered to {message.externalDelivery.platform}: {message.externalDelivery.error ?? "gateway unavailable"}</p> : null}
        {!message.deletedAt && <div className={cn(
          "absolute top-1 z-10 flex shrink-0 rounded-md border border-board-border bg-board-card text-board-muted opacity-100 shadow-sm transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100",
          isOwn ? "right-full mr-2" : "left-full ml-2",
        )}>
        {onReply && <button type="button" onClick={() => onReply(message)} className="touch-manipulation p-2 transition hover:bg-board-border/60 hover:text-fire-300 sm:p-1.5" aria-label={`Reply to ${message.senderName}`} title="Reply"><Reply className="h-3.5 w-3.5" /></button>}
        {onToggleReaction && <button type="button" onClick={() => setReactionPickerOpen((open) => !open)} className="touch-manipulation border-l border-board-border p-2 transition hover:bg-board-border/60 hover:text-board-text sm:p-1.5" aria-label="Choose reaction" title="Choose reaction"><Smile className="h-3.5 w-3.5" /></button>}
        {isOwn && onEdit && <button type="button" onClick={() => onEdit(message)} className="touch-manipulation border-l border-board-border p-2 transition hover:bg-board-border/60 hover:text-board-text sm:p-1.5" aria-label="Edit message" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>}
        {isOwn && onDelete && <button type="button" onClick={() => onDelete(message)} className="touch-manipulation border-l border-board-border p-2 transition hover:bg-red-500/10 hover:text-red-300 sm:p-1.5" aria-label="Delete message" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
        {reactionPickerOpen && <div className="absolute right-0 top-full z-20 mt-1 grid max-h-48 w-64 grid-cols-6 gap-1 overflow-y-auto rounded-lg border border-board-border bg-board-card p-2 shadow-xl">{MESSAGE_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => { setReactionPickerOpen(false); void onToggleReaction?.(message.id, emoji); }} className="rounded-md p-1.5 text-base hover:bg-board-border/60" aria-label={`React ${emoji}`}>{emoji}</button>)}</div>}
        </div>}
      </div>
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
  onSendMessage: (text: string, type: MessageType, options?: ChatMessageOptions) => void;
  onUploadAttachment?: (file: File) => Promise<ChatAttachment>;
  onEditMessage?: (messageId: string, text: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
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
  onVotePoll?: (messageId: string, optionId: string) => Promise<void>;
  onToggleReaction?: (messageId: string, emoji: string) => Promise<void>;
  focusedMessageId?: string;
  gatewayStatus?: ChatGatewayStatus;
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
  onUploadAttachment,
  attachmentAccessToken,
  onEditMessage,
  onDeleteMessage,
  mentionMembers = [],
  typingUsers = [],
  onTypingChange,
  seenThrough,
  onVotePoll,
  onToggleReaction,
  focusedMessageId,
  gatewayStatus,
}: ChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [openImage, setOpenImage] = useState<{ name: string; url: string } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [messageActionError, setMessageActionError] = useState<string | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const pinTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedAtRef = useRef(Date.now());
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  useEffect(() => {
    if (!focusedMessageId) return;
    document.getElementById(`chat-message-${focusedMessageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedMessageId, messages]);

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
    if (!inputText.trim() && pendingAttachments.length === 0) return;
    onTypingChange?.(false);
    if (editingMessage) {
      if (inputText.trim() && onEditMessage) {
        const messageId = editingMessage.id;
        const nextText = inputText.trim();
        void onEditMessage(messageId, nextText).then(() => {
          setEditingMessage(null);
          setInputText("");
          setMessageActionError(null);
        }).catch((error) => setMessageActionError(error instanceof Error ? error.message : "Could not edit message"));
      }
      return;
    }
    const replyTarget = replyingTo;
    onSendMessage(inputText.trim(), messageType, {
      replyTo: replyTarget ? { messageId: replyTarget.id, senderName: replyTarget.senderName, text: replyTarget.text } : undefined,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
      mentionedUserIds: mentionedUserIds(inputText, mentionMembers),
    });
    setInputText("");
    setReplyingTo(null);
    setPendingAttachments([]);
    setMessageType("text");

    // Re-focus textarea
    textareaRef.current?.focus();
  };

  const sendPoll = () => {
    const options = pollOptions.map((text) => text.trim()).filter(Boolean);
    if (!pollQuestion.trim() || options.length < 2) return;
    onSendMessage("", "text", { poll: { question: pollQuestion.trim(), options: options.map((text) => ({ id: "", text, voterIds: [] })) } });
    setPollOpen(false); setPollQuestion(""); setPollOptions(["", ""]);
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
    setEditingMessage(message);
    setReplyingTo(null);
    setPendingAttachments([]);
    setInputText(message.text);
    textareaRef.current?.focus();
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
      await onDeleteMessage(message.id);
      setMessageActionError(null);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Could not delete message");
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

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, Math.max(0, 6 - pendingAttachments.length));
    event.target.value = "";
    if (!onUploadAttachment || files.length === 0) return;
    setUploadError(null);
    setUploadingCount((count) => count + files.length);
    const results = await Promise.allSettled(files.map(onUploadAttachment));
    const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    setPendingAttachments((current) => [...current, ...uploaded].slice(0, 6));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) setUploadError(failed.reason instanceof Error ? failed.reason.message : "Some files could not be uploaded");
    setUploadingCount((count) => Math.max(0, count - files.length));
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
    setEditingMessage(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const gatewaySummary = gatewayStatus?.platform
    ? `${gatewayStatus.platform} ${gatewayStatus.status === "connected" ? "synced" : gatewayStatus.status}`
    : null;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-board-card",
        className,
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-board-border bg-board-bg/25 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-board-border bg-board-bg">
            <Hash className="h-4 w-4 text-board-muted" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-board-text truncate">{title}</span>
              {unreadCount > 0 && <span className="rounded-full bg-fire-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-black">{unreadCount > 99 ? "99+" : unreadCount}</span>}
            </div>
            {subtitle || gatewaySummary ? (
              <p className={cn("mt-0.5 flex items-center gap-1.5 truncate text-[10px]", gatewayStatus?.status === "error" ? "text-red-300" : "text-board-muted")} title={gatewayStatus?.error}><ConnectionDot status={connectionStatus} />{connectionStatus === "connected" ? "Live" : connectionStatus}{subtitle ? ` · ${subtitle}` : ""}{gatewaySummary ? ` · ${gatewaySummary}` : ""}</p>
            ) : null}
          </div>
        </div>
        {dockedLiveStatus && (
          <div className="ml-auto hidden min-w-0 max-w-[48%] items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/[0.07] px-2.5 py-1.5 sm:flex" title={dockedLiveStatus}>
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            <div className="min-w-0">
              <p className="text-[8px] font-bold uppercase tracking-[0.12em] text-green-400/75">Now live</p>
              <p className="truncate text-[10px] font-medium text-board-text/85">{dockedLiveStatus}</p>
            </div>
            {dockedLiveTimestamp && <span className="shrink-0 text-[8px] tabular-nums text-board-muted/45">{formatTimestamp(dockedLiveTimestamp)}</span>}
          </div>
        )}
        {headerActions && <div className={cn("flex shrink-0 items-center", !dockedLiveStatus && "ml-auto")}>{headerActions}</div>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            title="Close chat"
            className="ml-auto text-board-muted hover:text-board-text transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {dockedLiveStatus && (
        <div className="flex shrink-0 items-center gap-2 border-b border-board-border bg-green-500/[0.05] px-4 py-2 sm:hidden">
          <span className="h-2 w-2 shrink-0 rounded-full bg-green-400" />
          <span className="text-[9px] font-bold uppercase tracking-wider text-green-400/75">Now live</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-board-text/85">{dockedLiveStatus}</span>
          {dockedLiveTimestamp && <span className="text-[9px] tabular-nums text-board-muted/45">{formatTimestamp(dockedLiveTimestamp)}</span>}
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
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto py-2 modern-scrollbar"
      >
        {displayMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-board-muted">
            <MessageSquare className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">
              {pinnedAlerts.length > 0 ? "Only active alerts are showing right now" : "Production chat will appear here"}
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
                <div className="my-2 flex items-center gap-3 px-4" role="separator">
                  <span className="h-px flex-1 bg-board-border/70" />
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-board-muted/55">{formatDay(msg.timestamp)}</span>
                  <span className="h-px flex-1 bg-board-border/70" />
                </div>
              )}
              <ChatMessageRow message={msg} grouped={grouped} isFocused={msg.id === focusedMessageId} isOwn={Boolean(currentUserId ? msg.senderId === currentUserId : currentUserName && msg.senderName === currentUserName)} onReply={beginReply} onEdit={onEditMessage ? beginEdit : undefined} onDelete={onDeleteMessage ? deleteMessage : undefined} attachmentAccessToken={attachmentAccessToken} isSeen={msg.id === latestSeenOwnMessageId} currentUserId={currentUserId} onVotePoll={onVotePoll} onToggleReaction={onToggleReaction} onOpenImage={setOpenImage} />
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
        {pollOpen && <div className="mb-2 rounded-xl border border-board-border bg-board-card p-3 shadow-xl"><div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-sky-300" /><p className="text-xs font-semibold text-board-text">Create a poll</p><button type="button" onClick={() => setPollOpen(false)} className="ml-auto text-board-muted" aria-label="Close poll composer"><X className="h-4 w-4" /></button></div><input value={pollQuestion} onChange={(event) => setPollQuestion(event.target.value)} placeholder="Ask a question" className="mt-3 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-xs text-board-text outline-none" />{pollOptions.map((option, index) => <input key={index} value={option} onChange={(event) => setPollOptions((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`Option ${index + 1}`} className="mt-2 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-xs text-board-text outline-none" />)}<div className="mt-3 flex items-center gap-2"><button type="button" disabled={pollOptions.length >= 6} onClick={() => setPollOptions((items) => [...items, ""])} className="flex items-center gap-1 text-[10px] text-board-muted"><Plus className="h-3 w-3" />Add option</button><button type="button" disabled={!pollQuestion.trim() || pollOptions.filter((item) => item.trim()).length < 2} onClick={sendPoll} className="ml-auto rounded-lg bg-sky-400 px-3 py-2 text-[10px] font-semibold text-black disabled:opacity-40">Send poll</button></div></div>}
        {mentionSuggestions.length > 0 && !editingMessage && (
          <div className="mb-2 overflow-hidden rounded-xl border border-board-border bg-board-card shadow-xl">
            <div className="flex items-center gap-2 border-b border-board-border px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-board-muted"><AtSign className="h-3 w-3" />Mention someone</div>
            {mentionSuggestions.map((member) => <button key={member.userId} type="button" onClick={() => insertMention(member)} className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-board-border/45"><span className={cn("flex h-7 w-7 items-center justify-center rounded-lg border text-[9px] font-bold", avatarStyle(member.name))}>{initials(member.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-board-text">{member.name}</span><span className="block text-[9px] uppercase tracking-wide text-board-muted">{member.role}</span></span></button>)}
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-board-border/90 bg-board-bg/55 shadow-[0_12px_32px_rgba(0,0,0,0.18)] transition focus-within:border-fire-500/45 focus-within:ring-2 focus-within:ring-fire-500/10">
          {editingMessage && <div className="flex items-center gap-3 border-b border-board-border/70 bg-sky-500/[0.045] px-3 py-2"><Pencil className="h-3.5 w-3.5 text-sky-300" /><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold text-sky-300">Editing message</p><p className="truncate text-[10px] text-board-muted">Changes update for everyone in this room.</p></div><button type="button" onClick={() => { setEditingMessage(null); setInputText(""); }} className="rounded p-1 text-board-muted hover:bg-board-border hover:text-board-text" aria-label="Cancel edit"><X className="h-3.5 w-3.5" /></button></div>}
          {replyingTo && (
            <div className="flex items-center gap-3 border-b border-board-border/70 bg-fire-500/[0.045] px-3 py-2">
              <Reply className="h-3.5 w-3.5 shrink-0 text-fire-300" />
              <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold text-fire-300">Replying to {replyingTo.senderName}</p><p className="truncate text-[10px] text-board-muted">{replyingTo.text || "Attachment"}</p></div>
              <button type="button" onClick={() => setReplyingTo(null)} className="rounded p-1 text-board-muted hover:bg-board-border hover:text-board-text" aria-label="Cancel reply"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {(pendingAttachments.length > 0 || uploadingCount > 0) && (
            <div className="flex gap-2 overflow-x-auto border-b border-board-border/70 px-3 py-2 modern-scrollbar">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id} className="flex min-w-0 max-w-52 shrink-0 items-center gap-2 rounded-lg border border-board-border bg-board-card px-2.5 py-2">
                  {attachment.mimeType.startsWith("image/") ? <ImageIcon className="h-4 w-4 shrink-0 text-sky-300" /> : <FileText className="h-4 w-4 shrink-0 text-fire-300" />}
                  <span className="min-w-0 flex-1 truncate text-[10px] text-board-text">{attachment.name}</span>
                  <button type="button" onClick={() => setPendingAttachments((items) => items.filter((item) => item.id !== attachment.id))} className="text-board-muted hover:text-board-text" aria-label={`Remove ${attachment.name}`}><X className="h-3 w-3" /></button>
                </div>
              ))}
              {Array.from({ length: uploadingCount }, (_, index) => <div key={`uploading-${index}`} className="flex h-9 w-24 shrink-0 items-center justify-center gap-2 rounded-lg border border-board-border bg-board-card text-[10px] text-board-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Uploading</div>)}
            </div>
          )}
          <div className="flex items-center border-b border-board-border/70 px-2 py-1.5">
            {allowOperationalMessages && !editingMessage ? (
              <MessageTypeSelector value={messageType} onChange={setMessageType} />
            ) : (
              <span className="px-2 py-1 text-[10px] font-medium text-board-muted">{editingMessage ? "Edit message" : "Guest message"}</span>
            )}
            <span className="ml-auto px-2 text-[9px] text-board-muted/55">{pendingAttachments.length}/6 files</span>
            {onVotePoll && !editingMessage ? <button type="button" onClick={() => setPollOpen((open) => !open)} className="rounded-md p-1.5 text-board-muted hover:bg-board-border hover:text-sky-300" aria-label="Create poll" title="Create poll"><BarChart3 className="h-3.5 w-3.5" /></button> : null}
          </div>
          <div className="flex items-end gap-2 p-2">
          {onUploadAttachment && !editingMessage && (
            <>
              <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={handleFiles} className="hidden" />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={pendingAttachments.length >= 6 || uploadingCount > 0} className="mb-0.5 shrink-0 rounded-lg p-2.5 text-board-muted transition hover:bg-board-border/70 hover:text-board-text disabled:cursor-not-allowed disabled:opacity-40" aria-label="Attach photos or documents" title="Attach photos or documents"><Paperclip className="h-4 w-4" /></button>
            </>
          )}
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
              "min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-board-text placeholder:text-board-muted/45 outline-none modern-scrollbar",
              messageType === "cue" && "font-mono",
            )}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={(!inputText.trim() && pendingAttachments.length === 0) || uploadingCount > 0}
            className={cn(
              "mb-0.5 shrink-0 rounded-lg p-2.5 shadow-sm transition-all touch-manipulation",
              (inputText.trim() || pendingAttachments.length > 0) && uploadingCount === 0
                ? "bg-fire-500 text-black hover:bg-fire-400"
                : "bg-board-border text-board-muted cursor-not-allowed",
            )}
            aria-label={editingMessage ? "Save message" : "Send message"}
          >
            <Send className="w-4 h-4" />
          </button>
          </div>
        </div>
        {(uploadError || messageActionError) && <p className="mt-1.5 px-1 text-[10px] text-red-400">{uploadError || messageActionError}</p>}
      </div>
      {openImage ? (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label={openImage.name}>
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-3">
            <button type="button" onClick={() => setOpenImage(null)} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20" aria-label="Close image"><X className="h-5 w-5" /></button>
            <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-white/85">{openImage.name}</span>
            <a href={openImage.url} download={openImage.name} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20" aria-label="Download image"><Download className="h-4 w-4" /></a>
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
