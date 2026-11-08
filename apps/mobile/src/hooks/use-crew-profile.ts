import { useEffect, useMemo, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  crewCommandSchema,
  crewReceiptSchema,
  crewReadSchema,
  crewDraftFromSnapshot,
  type CrewDraft,
  type CrewCommand,
  type CrewReceipt,
  type CrewRead,
} from "../lib/crew-recovery";
const family = "mobile-crew-draft",
  requestsFamily = "mobile-crew-request";
export function useCrewDrafts(scope: { orgId: string; userId: string }) {
  return useRetainedDraftList<CrewDraft | null>(family, scope).filter(
    (value): value is CrewDraft => value !== null,
  );
}
export function useCrewProfile(
  scope: { orgId: string; userId: string },
  initial: CrewDraft,
  options: {
    active: boolean;
    send: (
      command: CrewCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<CrewReceipt>;
    read: (
      scope: { orgId: string; userId: string; id: string },
      signal: AbortSignal,
    ) => Promise<CrewRead>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient(),
    key = [family, scope.userId, scope.orgId, initial.slot],
    hash = hashKey(key);
  const requestKey = [requestsFamily, scope.userId, scope.orgId, initial.slot];
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const draft =
    useCrewDrafts(scope).find((value) => value.slot === initial.slot) ??
    initial;
  const cached = () => client.getQueryData<CrewDraft | null>(key);
  async function send(
    command: CrewCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const result = crewReceiptSchema.parse(
      await options.send(command, review, signal),
    );
    if (
      result.kind !== command.kind ||
      (command.kind !== "create" && result.id !== command.id)
    )
      throw new Error("The reply does not match the crew change you reviewed.");
    return result;
  }
  const requests = useRetainedRequests(scope, {
    family: requestsFamily,
    scopeKey: initial.slot,
    enabled: options.active,
    slot: () => "save",
    send: (command: CrewCommand, signal) => send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => crewReceiptSchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The crew change could not be confirmed. Retry or review the original request.",
    refresh: options.refresh,
  });
  const attempt = requests.work.save;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>(requestKey)?.save;
  const owner = useMemo<{ controller: AbortController | null }>(
    () => ({ controller: null }),
    // The account, profile and focus generation owns each current-profile read.
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
    if (options.active && !cached()) client.setQueryData(key, initial);
    return () => owner.controller?.abort();
    // A cleared slot is initialized only on reopening or a new focus generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, options.active]);
  function setFields(fields: Partial<CrewDraft["fields"]>) {
    if (!requests.isActive() || currentAttempt() || owner.controller) return;
    client.setQueryData<CrewDraft | null>(key, (current) =>
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
    const command = crewCommandSchema.safeParse({
      orgId: scope.orgId,
      userId: scope.userId,
      requestId: createLocalRequestUuid(),
      kind: current.kind,
      ...(current.kind === "delete" ? {} : current.fields),
      ...(current.base
        ? {
            id: current.base.id,
            expectedRevision: current.base.profileRevision,
          }
        : {}),
    });
    if (!command.success) {
      setLoad({
        owner,
        kind: "failed",
        message:
          "Check the member ID, name, role, email and photo before saving.",
      });
      return;
    }
    setLoad({ owner, kind: "idle" });
    requests.start(
      command.data,
      `${current.kind}: ${current.fields.name || "New crew member"}`,
    );
  }
  async function loadCurrent() {
    const previous = cached(),
      original = currentAttempt();
    if (
      !requests.isActive() ||
      !previous ||
      !previous.base ||
      owner.controller ||
      (original &&
        (original.kind !== "confirmed" ||
          original.refresh !== "done" ||
          (original.command.kind === "delete" &&
            original.result.outcome === "applied")))
    )
      return;
    const controller = new AbortController();
    owner.controller = controller;
    setLoad({ owner, kind: "pending" });
    try {
      const result = await runMobileOperation(
        async (child) =>
          crewReadSchema.parse(
            await options.read(
              {
                orgId: scope.orgId,
                userId: scope.userId,
                id: previous.base.id,
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
        result.id !== previous.base.id ||
        (result.snapshot && result.snapshot.id !== previous.base.id)
      )
        throw new Error(
          "Your account or crew selection changed. Reopen the roster.",
        );
      if (
        !requests.isActive() ||
        currentOwner.current !== owner ||
        cached() !== previous ||
        currentAttempt() !== original
      )
        return;
      if (!result.snapshot)
        throw new Error(
          "This crew member is no longer in the roster. Your draft is still here.",
        );
      if (original) requests.dismiss("save");
      const replacement = crewDraftFromSnapshot(previous.kind, result.snapshot);
      client.setQueryData<CrewDraft | null>(key, (value) =>
        value === previous ? replacement : value,
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
              : "Could not load the current crew profile.",
        });
    } finally {
      if (owner.controller === controller) owner.controller = null;
    }
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
    client.setQueryData<CrewDraft | null>(key, null);
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
    discard,
    loadCurrent: () => void loadCurrent(),
    retry: () => requests.retry("save"),
    review: () => requests.review("save"),
    refresh: () => requests.refresh("save"),
    editCancelled: () => {
      const original = currentAttempt();
      if (
        requests.isActive() &&
        original?.kind === "confirmed" &&
        original.refresh === "done" &&
        original.result.outcome === "cancelled"
      )
        requests.dismiss("save");
    },
  };
}
