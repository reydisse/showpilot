import { useEffect, useMemo, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  rundownDetailsDraft,
  rundownDetailsReplySchema,
  rundownDetailsCommandSchema,
  rundownDetailsReadSchema,
  type RundownDetailsDraft,
  type RundownDetailsReply,
  type RundownDetailsCommand,
  type RundownDetailsRead,
} from "../lib/rundown-details-recovery";
const family = "mobile-rundown-details-draft";
export function useRundownDetailsDraft(scope: {
  orgId: string;
  userId: string;
  showId: string;
}) {
  return (
    useRetainedDraftList<RundownDetailsDraft | null>(family, scope).find(
      (draft) => draft?.base.showId === scope.showId,
    ) ?? null
  );
}
export function useRundownDetails(
  scope: { orgId: string; userId: string; showId: string },
  options: {
    active: boolean;
    read: (
      scope: { orgId: string; userId: string; showId: string },
      signal: AbortSignal,
    ) => Promise<RundownDetailsRead>;
    send: (
      command: RundownDetailsCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<RundownDetailsReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient(),
    key = [family, scope.userId, scope.orgId, scope.showId],
    hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const draft = useRundownDetailsDraft(scope);
  const cached = () => client.getQueryData<RundownDetailsDraft | null>(key);
  async function send(
    command: RundownDetailsCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const result = rundownDetailsReplySchema.parse(
      await options.send(command, review, signal),
    );
    if (
      result.showId !== command.showId ||
      (result.snapshot && result.snapshot.id !== command.showId)
    )
      throw new Error("The reply belongs to a different rundown.");
    return result;
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-rundown-details-request",
    enabled: options.active,
    slot: () => "save",
    scopeKey: scope.showId,
    send: (command: RundownDetailsCommand, signal) =>
      send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => rundownDetailsReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The rundown details could not be confirmed. Retry or review the original request.",
    refresh: options.refresh,
  });
  const attempt = requests.work.save;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-rundown-details-request",
      scope.userId,
      scope.orgId,
      scope.showId,
    ])?.save;
  const owner = useMemo<{ controller: AbortController | null }>(
    () => ({ controller: null }),
    // Each account/focus generation owns and cancels its outstanding read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash, options.active],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [load, setLoad] = useState<{
    owner: typeof owner;
    kind: "idle" | "pending" | "failed";
    message?: string;
  }>({ owner, kind: "idle" });
  const reading = load.owner === owner && load.kind === "pending";
  useEffect(() => {
    if (options.active && !cached() && !currentAttempt()) void loadCurrent();
    return () => owner.controller?.abort();
    // One initial read for each account/focus generation. Failed reads need Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, options.active]);
  async function loadCurrent() {
    const previous = cached(),
      original = currentAttempt();
    if (
      !requests.isActive() ||
      owner.controller ||
      (original &&
        (original.kind !== "confirmed" || original.refresh !== "done"))
    )
      return;
    const controller = new AbortController();
    owner.controller = controller;
    setLoad({ owner, kind: "pending" });
    try {
      const result = await runMobileOperation(
        async (child) =>
          rundownDetailsReadSchema.parse(
            await options.read(
              {
                orgId: scope.orgId,
                userId: scope.userId,
                showId: scope.showId,
              },
              child.signal,
            ),
          ),
        controller.signal,
        8000,
      );
      if (
        result.orgId !== scope.orgId ||
        result.userId !== scope.userId ||
        result.showId !== scope.showId ||
        (result.snapshot && result.snapshot.id !== scope.showId)
      )
        throw new Error(
          "Your account or rundown selection changed. Reopen the editor.",
        );
      if (
        !requests.isActive() ||
        currentOwner.current !== owner ||
        cached() !== previous ||
        currentAttempt() !== original
      )
        return;
      const replacement = rundownDetailsDraft(result);
      if (original) requests.dismiss("save");
      client.setQueryData<RundownDetailsDraft | null>(key, (current) =>
        current === previous ? replacement : current,
      );
      setLoad({ owner, kind: "idle" });
    } catch (error) {
      if (requests.isActive() && currentOwner.current === owner)
        setLoad({
          owner,
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not load the rundown details.",
        });
    } finally {
      if (owner.controller === controller) owner.controller = null;
    }
  }
  function setFields(fields: Partial<RundownDetailsDraft["fields"]>) {
    if (!requests.isActive() || currentAttempt() || owner.controller) return;
    client.setQueryData<RundownDetailsDraft | null>(key, (current) =>
      current
        ? { ...current, fields: { ...current.fields, ...fields } }
        : current,
    );
  }
  function submit() {
    const current = cached();
    if (
      !requests.isActive() ||
      !current ||
      currentAttempt() ||
      owner.controller
    )
      return;
    const parsed = rundownDetailsCommandSchema.safeParse({
      ...current.fields,
      orgId: scope.orgId,
      userId: scope.userId,
      showId: scope.showId,
      requestId: createLocalRequestUuid(),
      expectedRevision: current.base.revision,
      expectedUpdatedAt: current.base.snapshot.updatedAt,
    });
    if (!parsed.success) {
      setLoad({
        owner,
        kind: "failed",
        message: "Check the title, venue and HH:mm times before saving.",
      });
      return;
    }
    setLoad({ owner, kind: "idle" });
    requests.start(parsed.data, "Rundown details");
  }
  function discard() {
    const original = currentAttempt();
    if (
      !requests.isActive() ||
      owner.controller ||
      (original &&
        (original.kind !== "confirmed" || original.refresh !== "done"))
    )
      return false;
    if (original) requests.dismiss("save");
    client.setQueryData<RundownDetailsDraft | null>(key, null);
    return true;
  }
  return {
    draft,
    attempt,
    reading,
    locked: !!attempt || reading,
    error: load.owner === owner ? load.message : undefined,
    setFields,
    submit,
    loadCurrent: () => void loadCurrent(),
    discard,
    retry: () => requests.retry("save"),
    review: () => requests.review("save"),
    editCancelled: () => {
      const attempt = currentAttempt();
      if (
        attempt?.kind === "confirmed" &&
        attempt.refresh === "done" &&
        attempt.result.outcome === "cancelled"
      )
        requests.dismiss("save");
    },
    refresh: () => requests.refresh("save"),
  };
}
