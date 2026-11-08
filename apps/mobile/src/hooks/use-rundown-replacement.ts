import { useEffect, useMemo, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  replacementReplySchema,
  replacementCommandSchema,
  replacementReadSchema,
  type ReplacementDraft,
  type ReplacementReply,
  type ReplacementCommand,
  type ReplacementRead,
  type ReplacementSource,
} from "../lib/rundown-replacement-recovery";
const family = "mobile-rundown-replacement-draft";
export function useRundownReplacementDraft(scope: {
  orgId: string;
  userId: string;
  showId: string;
}) {
  return (
    useRetainedDraftList<ReplacementDraft | null>(family, scope).find(
      (draft) => draft?.showId === scope.showId,
    ) ?? null
  );
}
export function useRundownReplacement(
  scope: { orgId: string; userId: string; showId: string },
  options: {
    active: boolean;
    read: (
      scope: {
        orgId: string;
        userId: string;
        showId: string;
        source: ReplacementSource;
      },
      signal: AbortSignal,
    ) => Promise<ReplacementRead>;
    send: (
      command: ReplacementCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<ReplacementReply>;
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
  const draft = useRundownReplacementDraft(scope);
  const cached = () => client.getQueryData<ReplacementDraft | null>(key);
  async function send(
    command: ReplacementCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const result = replacementReplySchema.parse(
      await options.send(command, review, signal),
    );
    if (result.showId !== command.showId)
      throw new Error("The reply belongs to a different rundown.");
    return result;
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-rundown-replacement-request",
    enabled: options.active,
    slot: () => "save",
    scopeKey: scope.showId,
    send: (command: ReplacementCommand, signal) => send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => replacementReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The rundown replacement could not be confirmed. Retry or review the original request.",
    refresh: options.refresh,
  });
  const attempt = requests.work.save;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-rundown-replacement-request",
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
    if (options.active && cached() && !cached()?.base && !currentAttempt())
      void loadCurrent();
    return () => owner.controller?.abort();
    // One initial read for each account/focus generation. Failed reads need Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, options.active]);
  async function loadCurrent() {
    const previous = cached(),
      original = currentAttempt();
    if (
      !requests.isActive() ||
      !previous ||
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
          replacementReadSchema.parse(
            await options.read(
              {
                orgId: scope.orgId,
                userId: scope.userId,
                showId: scope.showId,
                source: previous.source,
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
        result.source.kind !== previous.source.kind ||
        result.source.id !== previous.source.id
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
      const replacement: ReplacementDraft = {
        showId: scope.showId,
        source: previous.source,
        base: result,
      };
      if (original) requests.dismiss("save");
      client.setQueryData<ReplacementDraft | null>(key, (current) =>
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
              : "Could not load the reviewed replacement.",
        });
    } finally {
      if (owner.controller === controller) owner.controller = null;
    }
  }
  function choose(source: ReplacementSource) {
    if (
      !requests.isActive() ||
      cached() ||
      currentAttempt() ||
      owner.controller
    )
      return;
    client.setQueryData<ReplacementDraft | null>(key, () => ({
      showId: scope.showId,
      source,
      base: null,
    }));
    void loadCurrent();
  }
  function submit() {
    const current = cached();
    if (
      !requests.isActive() ||
      !current?.base ||
      !current.base.canReplace ||
      currentAttempt() ||
      owner.controller
    )
      return;
    const base = current.base;
    const parsed = replacementCommandSchema.safeParse({
      orgId: scope.orgId,
      userId: scope.userId,
      showId: scope.showId,
      source: base.source,
      serviceDate: base.serviceDate,
      expectedRevision: base.expectedRevision,
      expectedUpdatedAt: base.expectedUpdatedAt,
      copy: base.copy,
      requestId: createLocalRequestUuid(),
    });
    if (!parsed.success) {
      setLoad({
        owner,
        kind: "failed",
        message:
          parsed.error.issues[0]?.message ??
          "Review this replacement before confirming it.",
      });
      return;
    }
    setLoad({ owner, kind: "idle" });
    requests.start(parsed.data, base.label);
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
    client.setQueryData<ReplacementDraft | null>(key, null);
    return true;
  }
  return {
    draft,
    attempt,
    reading,
    locked: !!attempt || reading,
    error: load.owner === owner ? load.message : undefined,
    choose,
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
