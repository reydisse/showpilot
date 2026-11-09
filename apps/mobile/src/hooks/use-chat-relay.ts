import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetch as expoFetch } from "expo/fetch";
import { AppState } from "react-native";
import { createAuthenticatedWebSocket, getAuthenticatedFetchCredentials, getNativeCookieHeader } from "@/lib/auth-transport";
import { compareChatMessages, mergeChatMessage, parseChatHistoryPage, parseChatMessage,
  type ChatHistoryCursor, type MobileChatMessage, type MobileChatReactionEmoji } from "@/lib/chat-history";
import { SHOWPILOT_URL } from "@/lib/env";
import { runMobileOperation, MobileOperationTimeoutError } from "../lib/request-deadline";
import { notifyMobileChat } from "../lib/mobile-api";
import { chatNotificationResultSchema, type ChatNotificationCommand } from "../lib/chat-notification";
import { createLocalRequestUuid } from "../lib/request-id";
export type { MobileChatMessage } from "@/lib/chat-history";
type Status = "connecting" | "connected" | "reconnecting" | "offline";
type GatewayStatus = { platform: "mattermost" | "slack" | "discord" | "teams" | null; status: "disabled" | "connecting" | "connected" | "error"; error?: string };
export interface MobileChatSendOptions {
  mentionedUserIds?: string[];
  replyTo?: NonNullable<MobileChatMessage["replyTo"]>;
  attachments?: NonNullable<MobileChatMessage["attachments"]>;
  poll?: { question: string; options: string[] };
}
export interface MobileChatTypingState { userId?: string; name: string; typing: boolean }
type DeliveryBase = { id: string; text: string; createdAt: number; notification: ChatNotificationCommand };
export type ChatDelivery = DeliveryBase & (
  | { kind: "queued"; frame: string }
  | { kind: "sending"; frame: string }
  | { kind: "uncertain" | "rejected"; frame: string; error: string }
  | { kind: "notifying" }
  | { kind: "notification-failed"; error: string }
);

type Mutation = { type: "edit" | "delete" | "vote" | "reaction"; messageId: string; text?: string; optionId?: string; emoji?: MobileChatReactionEmoji };
type PendingMutation = { payload: Mutation; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Actions = { scope: string; retry(): void; send(text: string, type: MobileChatMessage["type"], options?: MobileChatSendOptions): string | null;
  retryMessage(id: string): void; retryNotifications(id: string): void; discardMessage(id: string): void; mutate(payload: Mutation): Promise<void>;
  transient(payload: object): void; loadOlder(): Promise<void> };
type ChatView = { scope: string; messages: MobileChatMessage[]; status: Status; lastError: string | null; historyError: string | null;
  hasOlder: boolean; loadingOlder: boolean; typingUsers: MobileChatTypingState[]; readReceipts: Record<string, number>; hydrated: boolean; gatewayStatus: GatewayStatus };
function emptyView(scope: string): ChatView {
  return { scope, messages: [], status: "connecting", lastError: null, historyError: null, hasOlder: false, loadingOlder: false,
    typingUsers: [], readReceipts: {}, hydrated: false, gatewayStatus: { platform: null, status: "connecting" } };
}
function chatUrl(orgId: string, roomId: string) {
  const url = new URL(SHOWPILOT_URL); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(orgId)}/ws`; url.search = new URLSearchParams({ room: roomId }).toString(); return url.toString();
}
function historyUrl(orgId: string, roomId: string, cursor: ChatHistoryCursor) {
  const url = new URL(SHOWPILOT_URL); url.pathname = `/api/chat/${encodeURIComponent(orgId)}/history`;
  url.search = new URLSearchParams({ room: roomId, limit: "200", beforeTimestamp: String(cursor.timestamp), beforeId: cursor.id }).toString(); return url.toString();
}
const uncertainMessage = "Delivery was not confirmed. It may have arrived. Retry the original message to check without posting it twice.";
const sendFailureMessage = "Chat could not send. Retry the message or reconnect.";

/** Each mounted room owns its socket and deadlines. Unconfirmed messages live in
 * the actor/org/room query cache so leaving the screen cannot silently lose them. */
export function useChatRelay(orgId: string | undefined, roomId = "production", userId: string | undefined) {
  const client = useQueryClient();
  const key = useMemo(() => ["mobile-chat-outbox", userId, orgId, roomId], [userId, orgId, roomId]);
  const scope = JSON.stringify(key), currentScope = useRef(scope); currentScope.current = scope;
  const { data: outbox = [] } = useQuery<ChatDelivery[]>({ queryKey: key, queryFn: () => [], initialData: [], enabled: false, gcTime: Infinity });
  const [view, setView] = useState(() => emptyView(scope));
  const actions = useRef<Actions | null>(null);
  useEffect(() => {
    let disposed = false, ready = false, attempts = 0, generation = 0;
    let socket: WebSocket | null = null, authentication: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined, handshake: ReturnType<typeof setTimeout> | undefined;
    let cursor: ChatHistoryCursor | null = null, hasOlder = false, history: AbortController | null = null;
    let snapshot: MobileChatMessage[] = [];
    const pending = new Map<string, PendingMutation>(), deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>(), typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const active = () => !disposed && currentScope.current === scope;
    const update = (patch: Partial<ChatView>) => { if (active()) setView(old => ({ ...(old.scope === scope ? old : emptyView(scope)), ...patch })); };
    const readOutbox = () => client.getQueryData<ChatDelivery[]>(key) ?? [];
    const changeOutbox = (change: (items: ChatDelivery[]) => ChatDelivery[]) => client.setQueryData<ChatDelivery[]>(key, items => change(items ?? []));
    const clearDeliveryTimer = (id: string) => { clearTimeout(deliveryTimers.get(id)); deliveryTimers.delete(id); };
    function notify(item: ChatDelivery) {
      const command = item.notification;
      const attempt: ChatDelivery = { id: item.id, text: item.text, createdAt: item.createdAt, notification: command, kind: "notifying" };
      const claim = changeOutbox(items => items.map(value => value === item ? attempt : value))?.find(value => value.id === item.id);
      if (!claim || claim.kind !== "notifying") return;
      // Notification delivery remains bounded and scoped even when its screen
      // unmounts. A later actor cannot inherit it or replace its result.
      void runMobileOperation(async controller => {
        const result = chatNotificationResultSchema.parse(await notifyMobileChat(command, controller.signal));
        if (result.orgId !== command.orgId || result.userId !== command.userId || result.roomId !== command.roomId
          || result.messageId !== command.messageId || result.requestId !== command.requestId)
          throw new Error("The notification result belongs to another message or account.");
        return result;
      }, undefined, 15000).then(() => {
        changeOutbox(items => items.filter(value => value !== claim));
      }).catch(error => {
        changeOutbox(items => items.map(value => value === claim ? { ...claim, kind: "notification-failed", error: error instanceof Error && !(error instanceof MobileOperationTimeoutError) ? error.message : "Crew notifications were not confirmed. Retry notifications without sending the message again." } : value));
      });
    }
    const acknowledge = (message: MobileChatMessage) => {
      const item = readOutbox().find(item => item.id === message.id);
      if (message.senderId !== userId || !item || item.kind === "notifying" || item.kind === "notification-failed") return;
      clearDeliveryTimer(message.id); notify(item);
      setView(old => old.lastError === sendFailureMessage ? { ...old, lastError: null } : old);
    };
    const cancelHistory = () => { history?.abort(); history = null; update({ loadingOlder: false }); };
    function disconnect() {
      generation++; ready = false;
      authentication?.abort(); authentication = null;
      clearTimeout(handshake); handshake = undefined;
      clearTimeout(reconnectTimer); reconnectTimer = undefined;
      cancelHistory();
      const old = socket; socket = null;
      if (old) { old.onopen = null; old.onmessage = null; old.onerror = null; old.onclose = null; old.close(); }
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Chat disconnected before the update completed. Check the current message before trying again.")); }
      pending.clear();
      for (const timer of deliveryTimers.values()) clearTimeout(timer);
      deliveryTimers.clear();
      changeOutbox(items => items.map(item => item.kind === "sending" ? { ...item, kind: "uncertain", error: uncertainMessage } : item));
      for (const timer of typingTimers.values()) clearTimeout(timer);
      typingTimers.clear(); update({ typingUsers: [] });
    }
    function reconnect() {
      if (!active() || reconnectTimer || AppState.currentState !== "active") return;
      update({ status: "reconnecting" });
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, Math.min(1000 * 2 ** attempts++, 30000));
    }
    function fail(message: string) {
      if (!active()) return;
      disconnect(); update({ lastError: message, status: "offline" }); reconnect();
    }
    function transmit(id: string) {
      const item = readOutbox().find(item => item.id === id);
      if (!active() || !ready || !socket || socket.readyState !== WebSocket.OPEN || !item || item.kind === "sending" || item.kind === "rejected" || item.kind === "notifying" || item.kind === "notification-failed") return;
      changeOutbox(items => items.map(value => value === item ? { ...item, kind: "sending" } : value));
      clearDeliveryTimer(id);
      deliveryTimers.set(id, setTimeout(() => {
        clearDeliveryTimer(id);
        if (active()) changeOutbox(items => items.map(value => value.id === id && value.kind === "sending" ? { ...value, kind: "uncertain", error: uncertainMessage } : value));
      }, 12000));
      try { socket.send(item.frame); }
      catch {
        clearDeliveryTimer(id);
        changeOutbox(items => items.map(value => value.id === id && value.kind === "sending" ? { ...value, kind: "uncertain", error: uncertainMessage } : value));
        update({ lastError: sendFailureMessage });
      }
    }
    function typing(state: MobileChatTypingState) {
      const id = state.userId || `name:${state.name}`;
      clearTimeout(typingTimers.get(id));
      setView(old => ({ ...old, typingUsers: [...old.typingUsers.filter(item => (item.userId || `name:${item.name}`) !== id), ...(state.typing ? [state] : [])] }));
      if (state.typing) typingTimers.set(id, setTimeout(() => {
        typingTimers.delete(id);
        if (active()) setView(old => ({ ...old, typingUsers: old.typingUsers.filter(item => (item.userId || `name:${item.name}`) !== id) }));
      }, 3500));
      else typingTimers.delete(id);
    }
    async function connect() {
      if (!active() || !orgId || !userId || authentication || socket || AppState.currentState !== "active") return;
      clearTimeout(reconnectTimer); reconnectTimer = undefined;
      const attempt = ++generation, controller = new AbortController(); authentication = controller;
      update({ status: attempts ? "reconnecting" : "connecting" });
      try {
        const connection = await createAuthenticatedWebSocket(chatUrl(orgId, roomId), undefined, controller.signal);
        if (!active() || attempt !== generation || AppState.currentState !== "active") { connection.close(); return; }
        authentication = null; socket = connection;
        const owns = () => active() && attempt === generation && socket === connection;
        handshake = setTimeout(() => { if (owns()) fail("Chat connection timed out before history arrived. Retry the connection."); }, 10000);
        // An open transport is not a ready room. Only hydration enables writes.
        connection.onopen = () => {};
        connection.onmessage = event => {
          if (!owns() || typeof event.data !== "string") return;
          try {
            const payload: unknown = JSON.parse(event.data);
            if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("type" in payload)) return;
            if (payload.type === "hydrate" && "messages" in payload && Array.isArray(payload.messages)) {
              const messages = payload.messages.map(parseChatMessage);
              if (messages.some(item => item === null)) throw new Error("Chat returned an invalid history snapshot. Retry the connection.");
              snapshot = messages.filter((item): item is MobileChatMessage => item !== null);
              cancelHistory();
              snapshot.forEach(acknowledge);
              cursor = snapshot[0] ? { timestamp: snapshot[0].timestamp, id: snapshot[0].id } : null;
              hasOlder = snapshot.length >= 2000;
              const receipts: Record<string, number> = {};
              if ("readReceipts" in payload && typeof payload.readReceipts === "object" && payload.readReceipts !== null)
                for (const [id, at] of Object.entries(payload.readReceipts)) if (typeof at === "number" && Number.isFinite(at)) receipts[id] = at;
              ready = true; attempts = 0; clearTimeout(handshake); handshake = undefined;
              update({ messages: snapshot, hydrated: true, status: "connected", lastError: null, historyError: null, hasOlder, readReceipts: receipts });
              if ("historyCleared" in payload && payload.historyCleared === true) void client.invalidateQueries({ queryKey: ["mobile-chat-unread"] });
              for (const item of readOutbox()) if (item.kind === "queued") transmit(item.id);
            } else if (payload.type === "message" || payload.type === "message-edited" || payload.type === "message-deleted") {
              const message = "message" in payload ? parseChatMessage(payload.message) : null;
              if (message) {
                acknowledge(message);
                snapshot = mergeChatMessage(snapshot, message);
                update({ messages: snapshot });
                void client.invalidateQueries({ queryKey: ["mobile-chat-unread"] });
              }
            } else if (payload.type === "error") {
              const error = "error" in payload && typeof payload.error === "string" ? payload.error : "Chat rejected an operation.";
              if ("messageId" in payload && typeof payload.messageId === "string") {
                const id = payload.messageId; clearDeliveryTimer(id);
                changeOutbox(items => items.map(item => item.id === id && "frame" in item ? { ...item, kind: "rejected", error } : item));
              } else update({ lastError: error });
            } else if (payload.type === "mutation-result" && "requestId" in payload && typeof payload.requestId === "string") {
              const item = pending.get(payload.requestId);
              if (item) {
                clearTimeout(item.timer); pending.delete(payload.requestId);
                if ("ok" in payload && payload.ok === true) {
                  const mutation = item.payload;
                  const target = snapshot.find(message => message.id === mutation.messageId);
                  if (mutation.type === "reaction" && mutation.emoji && orgId && userId && target?.senderId && target.senderId !== userId
                    && target.reactions?.some(reaction => reaction.emoji === mutation.emoji && reaction.userIds.includes(userId))) {
                    const notification: ChatNotificationCommand = { kind: "reaction", orgId, userId, roomId, requestId: payload.requestId,
                      messageId: target.id, targetUserId: target.senderId, emoji: mutation.emoji };
                    const delivery: ChatDelivery = { id: payload.requestId, notification, text: `Reaction ${mutation.emoji} to ${target.senderName}'s message`, createdAt: Date.now(), kind: "notifying" };
                    const stored = changeOutbox(items => [...items, delivery])?.find(value => value.id === delivery.id);
                    if (stored) notify(stored);
                  }
                  item.resolve();
                }
                else item.reject(new Error("error" in payload && typeof payload.error === "string" ? payload.error : "Message update failed."));
              }
            } else if (payload.type === "typing" && "name" in payload && typeof payload.name === "string" && "typing" in payload && typeof payload.typing === "boolean") {
              typing({ name: payload.name, typing: payload.typing, userId: "userId" in payload && typeof payload.userId === "string" ? payload.userId : undefined });
            } else if (payload.type === "read-receipt" && "userId" in payload && typeof payload.userId === "string" && "readAt" in payload && typeof payload.readAt === "number" && Number.isFinite(payload.readAt)) {
              const id = payload.userId, at = payload.readAt;
              setView(old => ({ ...old, readReceipts: { ...old.readReceipts, [id]: Math.max(old.readReceipts[id] ?? 0, at) } }));
              void client.invalidateQueries({ queryKey: ["mobile-chat-unread"] });
            } else if (payload.type === "gateway-status" && "status" in payload && (payload.status === "disabled" || payload.status === "connecting" || payload.status === "connected" || payload.status === "error")) {
              const platform = "platform" in payload && (payload.platform === "mattermost" || payload.platform === "slack" || payload.platform === "discord" || payload.platform === "teams") ? payload.platform : null;
              update({ gatewayStatus: { platform, status: payload.status, error: "error" in payload && typeof payload.error === "string" ? payload.error : undefined } });
            }
          } catch (error) { fail(error instanceof Error ? error.message : "A live chat update could not be read. Retry the connection."); }
        };
        connection.onerror = () => { if (owns()) fail("Chat connection interrupted. Retry the connection."); };
        connection.onclose = () => { if (owns()) fail("Chat disconnected. Showing last known messages."); };
      } catch (error) { if (active() && attempt === generation) { authentication = null; fail(error instanceof Error ? error.message : "Chat authentication failed."); } }
    }
    const controller: Actions = {
      scope,
      retry() { if (!active()) return; disconnect(); attempts = 0; void connect(); },
      send(text, type, options) {
        if (!active() || !orgId || !userId) return null;
        const clean = text.trim().slice(0, 4000);
        if (!clean && !options?.attachments?.length && !options?.poll) return null;
        const id = createLocalRequestUuid();
        const frame = JSON.stringify({ type: "message", clientMessageId: id, text: clean, messageType: type, replyTo: options?.replyTo, attachments: options?.attachments,
          poll: options?.poll ? { question: options.poll.question, options: options.poll.options.map(text => ({ id: "", text, voterIds: [] })) } : undefined });
        changeOutbox(items => [...items, { id, frame, text: clean || options?.poll?.question || options?.attachments?.map(item => item.name).join(", ") || "Message", createdAt: Date.now(), kind: "queued",
          notification: { kind: "message", orgId, userId, roomId, messageId: id, requestId: id,
            text: clean || options?.poll?.question || "", mentionedUserIds: options?.mentionedUserIds ?? [] } }]);
        transmit(id); return id;
      },
      retryMessage: transmit,
      retryNotifications(id) {
        const item = readOutbox().find(item => item.id === id);
        if (active() && item?.kind === "notification-failed") notify(item);
      },
      discardMessage(id) { if (active()) { clearDeliveryTimer(id); changeOutbox(items => items.filter(item => item.id !== id)); } },
      mutate(payload) {
        if (!active() || !ready || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat is not ready. Reconnect and try again."));
        const requestId = createLocalRequestUuid(), target = socket;
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("The message update was not confirmed. Check the current message before trying again.")); }, 8000);
          pending.set(requestId, { payload, resolve, reject, timer });
          try { target.send(JSON.stringify({ ...payload, requestId })); }
          catch { clearTimeout(timer); pending.delete(requestId); reject(new Error("Chat could not send the update. Check the connection and try again.")); }
        });
      },
      transient(payload) {
        if (!active() || !ready || !socket || socket.readyState !== WebSocket.OPEN) return;
        try { socket.send(JSON.stringify(payload)); } catch { fail("Chat connection interrupted. Retry the connection."); }
      },
      async loadOlder() {
        if (!active() || !orgId || !ready || !cursor || !hasOlder || history) return;
        const request = new AbortController(), requestedCursor = cursor; history = request;
        update({ loadingOlder: true, historyError: null });
        const owns = () => active() && history === request;
        try {
          const page = await runMobileOperation(async child => {
            const headers = await getNativeCookieHeader();
            if (child.signal.aborted) throw new Error("History request cancelled.");
            const response = await expoFetch(historyUrl(orgId, roomId, requestedCursor), { credentials: getAuthenticatedFetchCredentials(), headers: { Accept: "application/json", ...headers }, signal: child.signal });
            if (!response.ok) throw new Error(`Earlier messages could not be loaded (${response.status}).`);
            const page = parseChatHistoryPage(await response.json());
            if (!page) throw new Error("ShowPilot returned an invalid chat history page.");
            return page;
          }, request.signal, 10000);
          if (!owns()) return;
          cursor = page.nextCursor; hasOlder = cursor !== null;
          const byId = new Map([...page.messages, ...snapshot].map(item => [item.id, item]));
          snapshot = [...byId.values()].sort(compareChatMessages);
          update({ messages: snapshot, hasOlder, historyError: null });
        } catch (error) { if (owns()) update({ historyError: error instanceof MobileOperationTimeoutError ? "Earlier messages timed out. Retry loading earlier messages." : error instanceof Error ? error.message : "Earlier messages could not load." }); }
        finally { if (owns()) { history = null; update({ loadingOlder: false }); } }
      },
    };
    actions.current = controller;
    setView(emptyView(scope));
    if (!orgId || !userId) update({ status: "offline" }); else void connect();
    const subscription = AppState.addEventListener("change", state => {
      if (!active()) return;
      if (state === "active") void connect();
      else { disconnect(); update({ status: "offline" }); }
    });
    return () => { disposed = true; disconnect(); subscription.remove(); if (actions.current === controller) actions.current = null; };
  }, [client, key, orgId, roomId, scope, userId]);
  const current = useCallback(() => actions.current?.scope === currentScope.current ? actions.current : null, []);
  return { ...(view.scope === scope ? view : emptyView(scope)), outbox,
    retryConnection: useCallback(() => current()?.retry(), [current]),
    retryMessage: useCallback((id: string) => current()?.retryMessage(id), [current]),
    retryNotifications: useCallback((id: string) => current()?.retryNotifications(id), [current]),
    discardMessage: useCallback((id: string) => current()?.discardMessage(id), [current]),
    send: useCallback((text: string, type: MobileChatMessage["type"] = "text", options?: MobileChatSendOptions) => current()?.send(text, type, options) ?? null, [current]),
    editMessage: useCallback((messageId: string, text: string) => text.trim() ? current()?.mutate({ type: "edit", messageId, text: text.trim().slice(0, 4000) }) ?? Promise.reject(new Error("Chat is not ready.")) : Promise.reject(new Error("Message cannot be empty.")), [current]),
    deleteMessage: useCallback((messageId: string) => current()?.mutate({ type: "delete", messageId }) ?? Promise.reject(new Error("Chat is not ready.")), [current]),
    votePoll: useCallback((messageId: string, optionId: string) => current()?.mutate({ type: "vote", messageId, optionId }) ?? Promise.reject(new Error("Chat is not ready.")), [current]),
    toggleReaction: useCallback((messageId: string, emoji: MobileChatReactionEmoji) => current()?.mutate({ type: "reaction", messageId, emoji }) ?? Promise.reject(new Error("Chat is not ready.")), [current]),
    setTyping: useCallback((typing: boolean) => current()?.transient({ type: "typing", typing }), [current]),
    markRead: useCallback((readAt: number) => current()?.transient({ type: "read", readAt }), [current]),
    loadOlder: useCallback(() => current()?.loadOlder() ?? Promise.resolve(), [current]),
  };
}
