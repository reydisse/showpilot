import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRetainedRequests } from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  assignmentDraftFromSnapshot,
  assignmentReadSchema,
  assignmentRetryable,
  scheduleAssignmentCommandSchema,
  scheduleAssignmentResultSchema,
  type AssignmentDraft,
  type AssignmentRead,
  type ScheduleAssignmentCommand,
  type ScheduleAssignmentResult,
} from "../lib/assignment-recovery";

export function useMobileAssignment(
  scope: { orgId: string; userId: string },
  initial: AssignmentDraft,
  options: {
    active: boolean;
    send: (
      command: ScheduleAssignmentCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<ScheduleAssignmentResult>;
    read: (
      orgId: string,
      id: string,
      signal: AbortSignal,
    ) => Promise<AssignmentRead>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = [
      "mobile-assignment-draft",
      scope.userId,
      scope.orgId,
      initial.editorId,
    ],
    hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const cached = () => client.getQueryData<AssignmentDraft>(key);
  const draft = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => cached() ?? initial,
    () => cached() ?? initial,
  );
  const requestKey = [
    "mobile-assignment-request",
    scope.userId,
    scope.orgId,
    initial.editorId,
  ];
  const requests = useRetainedRequests(scope, {
    family: "mobile-assignment-request",
    scopeKey: initial.editorId,
    enabled: options.active,
    slot: () => "save",
    send: (command: ScheduleAssignmentCommand, signal) =>
      options.send(command, false, signal),
    review: (command, signal) => options.send(command, true, signal),
    parseResult: (input) => scheduleAssignmentResultSchema.parse(input),
    retryable: assignmentRetryable,
    dismissible: (result) => !assignmentRetryable(result),
    failureMessage: "The assignment save could not be confirmed.",
    refresh: options.refresh,
  });
  type Work = typeof requests.work;
  const currentAttempt = () => client.getQueryData<Work>(requestKey)?.save;
  const attempt = requests.work.save;
  const readOwner = useMemo(
    () => ({ controller: null as AbortController | null }),
    // A new account/editor or focus generation must invalidate late reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, options.active],
  );
  const [readState, setReadState] = useState<{
    owner: typeof readOwner;
    kind: "idle" | "pending" | "failed";
    message?: string;
  }>({ owner: readOwner, kind: "idle" });
  const reading = readState.owner === readOwner && readState.kind === "pending";
  const currentOwner = useRef(readOwner);
  currentOwner.current = readOwner;
  useEffect(
    () => () => {
      readOwner.controller?.abort();
    },
    [readOwner],
  );
  function setDraft(update: (draft: AssignmentDraft) => AssignmentDraft) {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return;
    client.setQueryData<AssignmentDraft>(key, (value) =>
      value ? update(value) : value,
    );
  }
  function submit() {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return;
    const value = cached();
    if (!value) return;
    const operation =
      value.mode === "create"
        ? { kind: "create", fields: value.fields }
        : value.base
          ? value.mode === "delete"
            ? {
                kind: "delete",
                id: value.base.id,
                expectedRevision: value.base.revision,
              }
            : {
                kind: "edit",
                id: value.base.id,
                expectedRevision: value.base.revision,
                fields: value.fields,
              }
          : null;
    const parsed = scheduleAssignmentCommandSchema.safeParse({
      ...scope,
      requestId: createLocalRequestUuid(),
      operation,
    });
    if (!parsed.success) {
      setReadState({
        owner: readOwner,
        kind: "failed",
        message:
          "Check the assignment fields and refresh its current version before saving.",
      });
      return;
    }
    requests.start(
      parsed.data,
      `${value.fields.role} · ${value.showName} (${value.fields.serviceDate})`,
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
          assignmentRetryable(original.result)))
    )
      return;
    const id =
      original?.kind === "confirmed"
        ? original.result.assignmentId
        : previous.base?.id;
    if (!id) return;
    const controller = new AbortController();
    readOwner.controller = controller;
    setReadState({ owner: readOwner, kind: "pending" });
    try {
      const result = await runMobileOperation(
        async (child) =>
          assignmentReadSchema.parse(
            await options.read(scope.orgId, id, child.signal),
          ),
        controller.signal,
        8000,
      );
      if (result.orgId !== scope.orgId || result.userId !== scope.userId)
        throw new Error("Your account changed. Reopen Schedule.");
      if (
        !requests.isActive() ||
        currentOwner.current !== readOwner ||
        cached() !== previous ||
        currentAttempt() !== original
      )
        return;
      if (!result.snapshot)
        throw new Error(
          "This position was removed. Your original draft is still here.",
        );
      const snapshot = result.snapshot;
      if (original) requests.dismiss("save");
      client.setQueryData<AssignmentDraft>(key, (value) =>
        value === previous
          ? {
              ...assignmentDraftFromSnapshot(
                {
                  ...previous,
                  fields: { ...previous.fields, timeZone: result.timeZone },
                },
                snapshot,
              ),
              mode: previous.mode === "delete" ? "delete" : "edit",
            }
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
              : "Current assignment could not be loaded.",
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
      original.result.outcome !== "conflict" ||
      draft.mode !== "create"
    )
      return;
    requests.dismiss("save");
  }
  function discard() {
    if (!requests.isActive() || currentAttempt() || readOwner.controller)
      return false;
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  function finish() {
    const original = currentAttempt();
    if (
      !requests.isActive() ||
      readOwner.controller ||
      original?.kind !== "confirmed" ||
      original.refresh !== "done" ||
      assignmentRetryable(original.result)
    )
      return false;
    requests.dismiss("save");
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  return {
    draft,
    attempt,
    reading,
    error: readState.owner === readOwner ? readState.message : undefined,
    locked: !!attempt || reading,
    setDraft,
    submit,
    loadCurrent: () => void loadCurrent(),
    editUnapplied,
    finish,
    discard,
    retry: () => requests.retry("save"),
    reviewOriginal: () => requests.review("save"),
    refresh: () => requests.refresh("save"),
  };
}

/** Keep abandoned/unconfirmed editors reachable even if their show or row is no
 * longer in the currently selected date. Query counters form a stable snapshot. */
export function useAssignmentDrafts(scope: { orgId: string; userId: string }) {
  const client = useQueryClient();
  const prefix = ["mobile-assignment-draft", scope.userId, scope.orgId];
  const relevant = useCallback(
    (key: readonly unknown[]) =>
      ["mobile-assignment-draft", "mobile-assignment-request"].includes(
        String(key[0]),
      ) &&
      key[1] === scope.userId &&
      key[2] === scope.orgId,
    [scope.userId, scope.orgId],
  );
  useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (relevant(event.query.queryKey)) notify();
        }),
      [client, relevant],
    ),
    () =>
      client
        .getQueryCache()
        .getAll()
        .filter((q) => relevant(q.queryKey))
        .map((q) => `${q.queryHash}:${q.state.dataUpdateCount}`)
        .join("|"),
    () => "",
  );
  return client
    .getQueriesData<AssignmentDraft>({ queryKey: prefix })
    .flatMap(([, draft]) => (draft ? [draft] : []));
}
