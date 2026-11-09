import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MobileChatMessage } from "../lib/chat-history";
export type ChatComposerDraft = {
  text: string; messageType: "text" | "cue" | "alert";
  replyingTo: MobileChatMessage | null; editing: MobileChatMessage | null;
  attachment: NonNullable<MobileChatMessage["attachments"]>[number] | null;
  pollQuestion: string; pollOptions: string[];
};
function blank(): ChatComposerDraft {
  return { text: "", messageType: "text", replyingTo: null, editing: null, attachment: null, pollQuestion: "", pollOptions: ["", ""] };
}
/** Drafts belong to a conversation and actor, never to whichever room renders next. */
export function useChatComposer(userId: string | undefined, orgId: string | undefined, roomId: string) {
  const client = useQueryClient();
  const key = useMemo(() => ["mobile-chat-composer", userId, orgId, roomId], [userId, orgId, roomId]);
  const hash = hashKey(key);
  const owner = useMemo(() => ({ key, initial: blank(), active: false }), [key]);
  const initial = owner.initial;
  useQuery({ queryKey: key, queryFn: () => initial, initialData: initial, enabled: false, gcTime: Infinity });
  const current = useRef(owner); current.current = owner;
  useEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  const read = useCallback(() => client.getQueryData<ChatComposerDraft>(key) ?? initial, [client, key, initial]);
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(event => {
    if (event.query.queryHash === hash) notify();
  }), [client, hash]);
  const draft = useSyncExternalStore(subscribe, read, read);
  const update = useCallback(<Field extends keyof ChatComposerDraft>(field: Field, value: ChatComposerDraft[Field] | ((previous: ChatComposerDraft[Field]) => ChatComposerDraft[Field])) => {
    if (!owner.active || current.current !== owner) return;
    client.setQueryData<ChatComposerDraft>(key, previous => {
      const before = previous ?? initial;
      return { ...before, [field]: typeof value === "function" ? value(before[field]) : value };
    });
  }, [client, key, initial, owner]);
  // A confirmed old-room edit may clear only the exact draft it submitted.
  // Newer typing and the room currently on screen are never cleared by it.
  const clear = useCallback((expected: ChatComposerDraft) => client.setQueryData<ChatComposerDraft>(key, previous => previous === expected ? { ...blank(), pollQuestion: previous.pollQuestion, pollOptions: previous.pollOptions } : previous), [client, key]);
  return { draft, capture: read, clear,
    setText: useCallback((value: string) => update("text", value), [update]),
    setMessageType: useCallback((value: ChatComposerDraft["messageType"]) => update("messageType", value), [update]),
    setReplyingTo: useCallback((value: MobileChatMessage | null) => update("replyingTo", value), [update]),
    setEditing: useCallback((value: MobileChatMessage | null) => update("editing", value), [update]),
    setAttachment: useCallback((value: ChatComposerDraft["attachment"]) => update("attachment", value), [update]),
    setPollQuestion: useCallback((value: string) => update("pollQuestion", value), [update]),
    setPollOptions: useCallback((value: string[] | ((previous: string[]) => string[])) => update("pollOptions", value), [update]),
  };
}
