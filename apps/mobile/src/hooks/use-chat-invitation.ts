import { runMobileOperation, MobileOperationTimeoutError } from "../lib/request-deadline";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRetainedDraftList, useRetainedRequests, type RetainedAttempt } from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import { chatInviteCommandSchema, chatInviteReplySchema, type ChatInviteCommand, type ChatInviteDraft, type ChatInviteReply } from "../lib/chat-pass-recovery";
const family = "mobile-chat-invitation-draft", requestFamily = "mobile-chat-invitation-request";
export function useChatInvitation(scope: { orgId: string; userId: string; scope: ChatInviteCommand["scope"] }, options: {
  active: boolean;
  send: (command: ChatInviteCommand, signal: AbortSignal) => Promise<ChatInviteReply>;
}) {
  const client = useQueryClient(), key = [family, scope.userId, scope.orgId, scope.scope];
  const initial = useMemo<ChatInviteDraft>(() => ({ scope: scope.scope, hours: 4, targetUserIds: [] }), [scope.scope]);
  useQuery({ queryKey: key, queryFn: () => initial, initialData: initial, enabled: false, gcTime: Infinity });
  const draft = useRetainedDraftList<ChatInviteDraft>(family, scope).find(item => item.scope === scope.scope) ?? initial;
  const requests = useRetainedRequests(scope, {
    family: requestFamily, scopeKey: scope.scope, enabled: options.active, slot: () => "invite",
    send: async (command: ChatInviteCommand, signal) => {
      const result = chatInviteReplySchema.parse(await options.send(command, signal));
      if (result.scope !== command.scope) throw new Error("This link belongs to another conversation.");
      const path = `/join/chat/${command.scope === "planning-chat" ? "planning/" : ""}${encodeURIComponent(result.token)}`;
      if (!["http:", "https:"].includes(new URL(result.joinUrl).protocol) || new URL(result.joinUrl).pathname !== path) throw new Error("The returned link does not match this invitation.");
      return result;
    },
    parseResult: input => chatInviteReplySchema.parse(input),
    retryable: result => result.notifications.status === "pending",
    dismissible: () => true,
    failureMessage: "The link result is unconfirmed. Retry the original request to recover it without creating another link.",
    refresh: async () => {},
  });
  const requestKey = [requestFamily, scope.userId, scope.orgId, scope.scope];
  type Work = Record<string, RetainedAttempt<ChatInviteCommand, ChatInviteReply>>;
  const currentAttempt = () => client.getQueryData<Work>(requestKey)?.invite;
  const attempt = requests.work.invite;
  useEffect(() => {
    if (attempt?.kind === "confirmed" && attempt.refresh === "idle") requests.refresh("invite");
    // A request may finish while the sheet is closed. Opening settles its no-op refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, options.active]);
  function setFields(fields: Partial<Pick<ChatInviteDraft, "hours" | "targetUserIds">>) {
    if (!requests.isActive() || currentAttempt()) return;
    client.setQueryData<ChatInviteDraft>(key, old => ({ ...(old ?? initial), ...fields, error: undefined }));
  }
  function create(memberIds: readonly string[]) {
    if (!requests.isActive() || currentAttempt()) return;
    const value = client.getQueryData<ChatInviteDraft>(key) ?? initial;
    const parsed = chatInviteCommandSchema.safeParse({ ...value, ...scope, requestId: createLocalRequestUuid() });
    const missing = scope.scope === "planning-chat" && value.targetUserIds.some(id => !memberIds.includes(id));
    if (!parsed.success || missing) {
      client.setQueryData<ChatInviteDraft>(key, { ...value, error: missing ? "A selected member is no longer available. Review your selection." : "Choose a duration from 1 to 24 hours and, for Planning, between 1 and 50 members." });
      return;
    }
    requests.start(parsed.data, scope.scope === "planning-chat" ? "Planning invite" : "Crew pass");
  }
  function startNew() {
    const current = currentAttempt();
    if (!requests.isActive() || current?.kind === "pending" || (current?.kind === "confirmed" && current.refresh === "pending")) return;
    client.setQueryData<Work>(requestKey, work => work?.invite === current ? {} : work);
    client.setQueryData<ChatInviteDraft>(key, old => ({ ...(old ?? initial), error: undefined }));
  }
  return { draft, attempt, locked: !!attempt,
    pass: attempt?.kind === "confirmed" ? attempt.result : attempt?.previous ?? null,
    setFields, create, retry: () => requests.retry("invite"), startNew,
  };
}

/** Sharing never changes or re-creates the already-issued link. */
export function useChatInviteSharing(pass: ChatInviteReply | null, active: boolean, share: (url: string) => Promise<"shared" | "dismissed">) {
  const owner = useMemo(() => ({ token: pass?.token, enabled: active, active: false, controller: null as AbortController | null }), [pass?.token, active]);
  const current = useRef(owner); current.current = owner;
  const [stored, setStored] = useState<{ owner: typeof owner; kind: "idle" | "pending" | "shared" | "dismissed" | "failed"; error?: string }>({ owner, kind: "idle" });
  useEffect(() => { owner.active = owner.enabled; return () => { owner.active = false; owner.controller?.abort(); }; }, [owner]);
  async function open() {
    if (!owner.active || current.current !== owner || owner.controller || !pass || pass.token !== owner.token || pass.expiresAt <= Date.now()) return;
    const controller = new AbortController(); owner.controller = controller;
    const owns = () => owner.active && current.current === owner && owner.controller === controller;
    setStored({ owner, kind: "pending" });
    try {
      const outcome = await runMobileOperation(() => share(pass.joinUrl), controller.signal, 15000);
      if (owns()) setStored({ owner, kind: outcome });
    } catch (error) {
      if (owns()) setStored({ owner, kind: "failed", error: error instanceof Error && !(error instanceof MobileOperationTimeoutError) ? error.message : "Sharing was not confirmed. Your link is still available below. Retry sharing or copy it manually." });
    } finally { if (owner.controller === controller) owner.controller = null; }
  }
  return { ...(stored.owner === owner ? stored : { kind: "idle" as const, error: undefined }), open };
}
