import { useEffect, useMemo, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  showDraftFromSnapshot,
  showManagementCommandSchema,
  showManagementReadSchema,
  showManagementReplySchema,
  type ShowManagementDraft,
  type ShowManagementCommand,
  type ShowManagementReply,
  type ShowManagementRead,
} from "../lib/show-management-recovery";

export function useShowManagementDrafts(scope: {
  orgId: string;
  userId: string;
}) {
  return useRetainedDraftList<ShowManagementDraft>(
    "mobile-show-management-draft",
    scope,
  );
}
/** Edit and delete share a slot for the same show. An unresolved edit cannot be
 * replaced by a delete, and accepted deletion cleanup cannot be abandoned. */
export function useShowManagement(
  scope: { orgId: string; userId: string },
  initial: ShowManagementDraft,
  options: {
    active: boolean;
    send: (
      command: ShowManagementCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<ShowManagementReply>;
    read: (
      input: { orgId: string; userId: string; showId: string },
      signal: AbortSignal,
    ) => Promise<ShowManagementRead>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = [
      "mobile-show-management-draft",
      scope.userId,
      scope.orgId,
      initial.showId,
    ],
    hash = hashKey(key);
  const requestKey = [
    "mobile-show-management-request",
    scope.userId,
    scope.orgId,
    initial.showId,
  ];
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const drafts = useShowManagementDrafts(scope);
  const draft =
    drafts.find((value) => value.showId === initial.showId) ?? initial;
  const cached = () => client.getQueryData<ShowManagementDraft>(key);
  async function send(
    command: ShowManagementCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const reply = showManagementReplySchema.parse(
      await options.send(command, review, signal),
    );
    if (
      reply.kind !== command.kind ||
      reply.showId !== command.showId ||
      (reply.kind === "edit" &&
        (reply.result.requestId !== command.requestId ||
          reply.result.showId !== command.showId ||
          (reply.result.snapshot &&
            reply.result.snapshot.id !== command.showId)))
    )
      throw new Error("Reply does not match the show you reviewed.");
    return reply;
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-show-management-request",
    scopeKey: initial.showId,
    enabled: options.active,
    slot: () => "save",
    send: (command: ShowManagementCommand, signal) =>
      send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => showManagementReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The change could not be confirmed. Keep this request and retry it to find its outcome.",
    refresh: options.refresh,
  });
  const attempt = requests.work.save;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>(requestKey)?.save;
  const readOwner = useMemo(
    () => ({ controller: null as AbortController | null }),
    // Each focus/account/show generation owns its read and invalidates old replies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, options.active],
  );
  const currentOwner = useRef(readOwner);
  currentOwner.current = readOwner;
  const [readState, setReadState] = useState<{
    owner: typeof readOwner;
    kind: "idle" | "pending" | "failed";
    message?: string;
  }>({ owner: readOwner, kind: "idle" });
  const reading = readState.owner === readOwner && readState.kind === "pending";
  useEffect(() => () => readOwner.controller?.abort(), [readOwner]);
  function setDraft(
    update: (value: ShowManagementDraft) => ShowManagementDraft,
  ) {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return;
    client.setQueryData<ShowManagementDraft>(key, (value) =>
      value ? update(value) : value,
    );
  }
  function submit() {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return;
    const value = cached();
    if (!value) return;
    const command = showManagementCommandSchema.safeParse({
      ...scope,
      requestId: createLocalRequestUuid(),
      showId: value.showId,
      kind: value.mode,
      expectedUpdatedAt: value.base.updatedAt,
      ...(value.mode === "edit" ? value.fields : {}),
    });
    if (!command.success) {
      setReadState({
        owner: readOwner,
        kind: "failed",
        message:
          "Check the details and load the current show version before continuing.",
      });
      return;
    }
    setReadState({ owner: readOwner, kind: "idle" });
    requests.start(
      command.data,
      `${value.mode === "delete" ? "Delete" : "Edit"}: ${value.base.name || "Untitled show"} (${value.base.serviceDate})`,
    );
  }
  async function loadCurrent() {
    const previous = cached(),
      original = currentAttempt();
    if (
      !requests.isActive() ||
      !previous ||
      readOwner.controller ||
      (original &&
        (original.kind !== "confirmed" ||
          original.refresh !== "done" ||
          (original.result.kind === "delete" && original.result.result.ok)))
    )
      return;
    const controller = new AbortController();
    readOwner.controller = controller;
    setReadState({ owner: readOwner, kind: "pending" });
    try {
      const result = await runMobileOperation(
        async (child) =>
          showManagementReadSchema.parse(
            await options.read(
              { ...scope, showId: previous.showId },
              child.signal,
            ),
          ),
        controller.signal,
        8000,
      );
      if (
        result.orgId !== scope.orgId ||
        result.userId !== scope.userId ||
        result.showId !== previous.showId ||
        (result.snapshot && result.snapshot.id !== previous.showId)
      )
        throw new Error(
          "Your account or selected show changed. Reopen Schedule.",
        );
      if (
        !requests.isActive() ||
        currentOwner.current !== readOwner ||
        cached() !== previous ||
        currentAttempt() !== original
      )
        return;
      if (!result.snapshot)
        throw new Error(
          "This show was removed. Your original draft is still here.",
        );
      const snapshot = result.snapshot;
      if (original) requests.dismiss("save");
      client.setQueryData<ShowManagementDraft>(key, (value) =>
        value === previous
          ? showDraftFromSnapshot(previous.mode, snapshot, result.timeZone)
          : value,
      );
      setReadState({ owner: readOwner, kind: "idle" });
    } catch (error) {
      if (requests.isActive() && currentOwner.current === readOwner)
        setReadState({
          owner: readOwner,
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the current show.",
        });
    } finally {
      if (readOwner.controller === controller) readOwner.controller = null;
    }
  }
  function editUnapplied() {
    const original = currentAttempt();
    if (
      !requests.isActive() ||
      original?.kind !== "confirmed" ||
      original.refresh !== "done" ||
      original.result.kind !== "edit" ||
      original.result.result.outcome !== "cancelled"
    )
      return;
    requests.dismiss("save");
  }
  function finish() {
    const original = currentAttempt();
    if (
      !requests.isActive() ||
      readOwner.controller ||
      original?.kind !== "confirmed" ||
      original.refresh !== "done"
    )
      return false;
    requests.dismiss("save");
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  function discard() {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return false;
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  return {
    draft,
    attempt,
    locked: !!attempt || reading,
    reading,
    error: readState.owner === readOwner ? readState.message : undefined,
    setDraft,
    submit,
    loadCurrent: () => void loadCurrent(),
    editUnapplied,
    finish,
    discard,
    retry: () => requests.retry("save"),
    refresh: () => requests.refresh("save"),
    reviewOriginal: () => {
      if (currentAttempt()?.command.kind === "edit") requests.review("save");
    },
  };
}
