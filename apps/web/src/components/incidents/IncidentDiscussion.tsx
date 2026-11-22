import { Fragment, useState, type ReactNode } from "react";
import { SmilePlus, X } from "lucide-react";
import { isEmojiReaction } from "@showpilot/shared";
import { REACTION_EMOJIS, type ContentReaction, type IncidentComment, type IncidentOperation } from "@/lib/incident-writes";
import { objectionableContentReason } from "@/lib/user-content-safety";
import { clockTime, dayMonth, PersonAvatar, secondaryButton } from "./incident-a";

/**
 * Threaded incident comments with reactions and a single-line composer.
 * Writes go through the caller's incident write queue (`onSave`).
 */
export function IncidentDiscussion({ incidentId, comments, reactions, viewerId, timeZone, disabled, onSave }: {
  incidentId: string;
  comments: IncidentComment[];
  reactions: ContentReaction[];
  viewerId: string;
  timeZone: string;
  disabled: boolean;
  onSave: (operation: IncidentOperation) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [customReaction, setCustomReaction] = useState("");
  const problem = objectionableContentReason(draft);
  const replyTarget = replyTo ? comments.find(comment => comment.id === replyTo) : null;

  const submit = async () => {
    const body = draft.trim();
    if (!body || problem || disabled) return;
    if (await onSave({ kind: "comment", incidentId, parentId: replyTo, body })) { setDraft(""); setReplyTo(null); }
  };
  const react = (commentId: string, emoji: string) => {
    const own = reactions.find(reaction => reaction.targetId === commentId && reaction.emoji === emoji && reaction.userId === viewerId);
    void onSave({ kind: "reaction", commentId, emoji, active: !own, expectedId: own?.id ?? null });
  };

  const render = (item: IncidentComment, depth = 0): ReactNode => {
    const itemReactions = reactions.filter(reaction => reaction.targetId === item.id);
    const children = comments.filter(candidate => candidate.parentId === item.id);
    const created = new Date(item.createdAt);
    return <Fragment key={item.id}>
      <div className={`grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 ${depth ? "ml-[38px] border-l border-[var(--sa-border)] pl-3" : ""}`}>
        <PersonAvatar name={item.authorName} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-semibold text-board-text">{item.authorName}</span>
            <span className="text-[11px] tabular-nums text-[var(--sa-ink-3)]">{dayMonth(created, timeZone)} · {clockTime(created, timeZone)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-board-text">{item.body}</p>
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {[...new Set(itemReactions.map(reaction => reaction.emoji))].map(emoji => {
              const count = itemReactions.filter(reaction => reaction.emoji === emoji).length;
              const mine = itemReactions.some(reaction => reaction.emoji === emoji && reaction.userId === viewerId);
              return <button key={emoji} type="button" disabled={disabled} onClick={() => react(item.id, emoji)} aria-label={`React ${emoji}`} aria-pressed={mine}
                className={`inline-flex h-6 items-center gap-[5px] rounded-full border pl-[7px] pr-2 text-xs disabled:opacity-50 [@media(pointer:coarse)]:h-9 ${mine ? "border-board-text/40 bg-board-text/[0.13] text-board-text" : "border-[var(--sa-border-strong)] bg-[var(--sa-surface)] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)]"}`}>
                <span>{emoji}</span><span className="text-[11px] tabular-nums">{count}</span>
              </button>;
            })}
            <span className="relative">
              <button type="button" disabled={disabled} onClick={() => setPickerFor(current => current === item.id ? null : item.id)} aria-label="Add reaction"
                className="inline-flex h-6 w-[30px] items-center justify-center rounded-full border border-dashed border-[var(--sa-border-strong)] text-[var(--sa-ink-3)] hover:border-solid hover:text-board-text disabled:opacity-50 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-11">
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
              {pickerFor === item.id ? <span className="fixed inset-x-4 bottom-4 z-40 block rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-2 shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:w-72">
                <span className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto">{REACTION_EMOJIS.map(emoji => <button key={emoji} type="button" disabled={disabled} onClick={() => { setPickerFor(null); react(item.id, emoji); }} aria-label={`React ${emoji}`} className="min-h-11 min-w-11 rounded-md p-1.5 text-base hover:bg-[var(--sa-surface-2)]">{emoji}</button>)}</span>
                <form className="mt-2 flex gap-1 border-t border-[var(--sa-border)] pt-2" onSubmit={event => { event.preventDefault(); if (!isEmojiReaction(customReaction)) return; setPickerFor(null); setCustomReaction(""); react(item.id, customReaction); }}>
                  <input aria-label="Type or paste any emoji" value={customReaction} onChange={event => setCustomReaction(event.target.value)} maxLength={32} placeholder="Any emoji" className="min-h-11 min-w-0 flex-1 rounded-md border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2 text-xs text-board-text outline-none focus:border-fire-500" />
                  <button type="submit" disabled={disabled || !isEmojiReaction(customReaction)} className="min-h-11 rounded-md bg-fire-500 px-2 text-xs font-semibold text-[#1a1300] disabled:opacity-40">Add</button>
                </form>
              </span> : null}
            </span>
            <button type="button" disabled={disabled} onClick={() => setReplyTo(item.id)} className="ml-1 inline-flex h-6 items-center rounded-md px-1.5 text-xs font-medium text-[var(--sa-ink-3)] hover:text-board-text disabled:opacity-50 [@media(pointer:coarse)]:h-11">Reply</button>
          </div>
        </div>
      </div>
      {children.map(child => render(child, depth + 1))}
    </Fragment>;
  };

  return <div className="flex flex-col">
    {comments.length ? <div className="flex flex-col gap-4 px-4 py-4">{comments.filter(comment => !comment.parentId).map(comment => render(comment))}</div>
      : <p className="px-4 py-4 text-[13px] text-[var(--sa-ink-3)]">No comments yet. Add the first update for the crew.</p>}
    <form className="flex flex-col gap-2 border-t border-[var(--sa-border)] px-4 py-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {replyTarget ? <div className="flex items-center gap-2 text-xs text-[var(--sa-ink-2)]"><span className="min-w-0 flex-1 truncate">Replying to <span className="font-medium text-board-text">{replyTarget.authorName}</span></span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="flex h-6 w-6 items-center justify-center rounded text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"><X className="h-3.5 w-3.5" /></button></div> : null}
      {problem ? <p role="alert" className="text-xs text-[var(--sa-danger)]">{problem}</p> : null}
      <div className="flex items-center gap-2">
        <textarea aria-label="Add a comment" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          rows={1} maxLength={2000} placeholder={replyTarget ? "Write a reply…" : "Add a comment…"}
          className="min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 py-3 text-base leading-5 text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 sm:text-[13px]" />
        <button type="submit" disabled={disabled || !draft.trim() || !!problem} className={`${secondaryButton} h-11 px-4`}>Comment</button>
      </div>
    </form>
  </div>;
}
