import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChatComposer, composerFields } from "@showpilot/shared/chat-composer";
import type { MobileChatMessage } from "../lib/chat-history";
const clients = new WeakMap<QueryClient, Map<string, ChatComposer<MobileChatMessage>>>();
/** Account, organization, and room own the draft. Old views cannot mutate a newer view. */
export function useChatComposer(userId: string | undefined, orgId: string | undefined, roomId: string) {
  const client = useQueryClient();
  const composer = useMemo(() => {
    if (!userId || !orgId) return new ChatComposer<MobileChatMessage>();
    let drafts = clients.get(client);
    if (!drafts) { drafts = new Map(); clients.set(client, drafts); }
    const key = JSON.stringify([userId, orgId, roomId]);
    let saved = drafts.get(key);
    if (!saved) { saved = new ChatComposer<MobileChatMessage>(); drafts.set(key, saved); }
    return saved;
  }, [client, userId, orgId, roomId]);
  const owner = useMemo(() => ({ composer, active: false }), [composer]);
  const current = useRef(owner); current.current = owner;
  useEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  const snapshot = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot);
  const draft = useMemo(() => composerFields(snapshot), [snapshot]);
  const actions = useMemo(() => {
    function guard<Args extends unknown[]>(action: (...args: Args) => void) {
      return (...args: Args) => { if (owner.active && current.current === owner) action(...args); };
    }
    return { setText: guard(composer.setText), setMessageType: guard(composer.setMessageType),
      setReplyingTo: guard(composer.setReplyingTo), beginEdit: guard(composer.beginEdit), cancelEdit: guard(composer.cancelEdit),
      setPollQuestion: guard(composer.setPollQuestion), setPollOptions: guard(composer.setPollOptions), setPollOpen: guard(composer.setPollOpen) };
  }, [composer, owner]);
  // Completion may clear the original room, but only its exact submitted section.
  return { draft,
    send: useCallback(composer.send.bind(composer), [composer]), ...actions };
}
