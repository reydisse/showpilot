import { useEffect, useMemo, useRef, useState } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  providerDraft,
  providerReplySchema,
  scheduleProviderCommandSchema,
  scheduleProviderSnapshotSchema,
  type ProviderDraft,
  type ProviderReply,
  type ScheduleProviderCommand,
  type ScheduleProviderSnapshot,
} from "../lib/schedule-provider-recovery";
const family = "mobile-provider-draft";
export function useScheduleProviderDraft(scope: {
  orgId: string;
  userId: string;
}) {
  return useRetainedDraftList<ProviderDraft | null>(family, scope)[0] ?? null;
}
export function useScheduleProvider(
  scope: { orgId: string; userId: string },
  options: {
    active: boolean;
    read: (
      scope: { orgId: string; userId: string },
      signal: AbortSignal,
    ) => Promise<ScheduleProviderSnapshot>;
    send: (
      command: ScheduleProviderCommand,
      signal: AbortSignal,
    ) => Promise<ProviderReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient(),
    key = [family, scope.userId, scope.orgId],
    hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const draft = useScheduleProviderDraft(scope);
  const cached = () => client.getQueryData<ProviderDraft | null>(key);
  const requests = useRetainedRequests(scope, {
    family: "mobile-provider-request",
    enabled: options.active,
    slot: () => "save",
    send: async (command: ScheduleProviderCommand, signal) => {
      const result = providerReplySchema.parse(
        await options.send(command, signal),
      );
      if (
        result.snapshot.orgId !== command.orgId ||
        result.snapshot.userId !== command.userId
      )
        throw new Error(
          "The reply belongs to a different account or organization.",
        );
      return result;
    },
    parseResult: (input) => providerReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The scheduling source could not be confirmed. Retry the original request to find its outcome.",
    refresh: options.refresh,
  });
  const attempt = requests.work.save;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-provider-request",
      scope.userId,
      scope.orgId,
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
          scheduleProviderSnapshotSchema.parse(
            await options.read(
              { orgId: scope.orgId, userId: scope.userId },
              child.signal,
            ),
          ),
        controller.signal,
        8000,
      );
      if (result.orgId !== scope.orgId || result.userId !== scope.userId)
        throw new Error(
          "Your account or organization changed. Reopen Schedule.",
        );
      if (
        !requests.isActive() ||
        currentOwner.current !== owner ||
        cached() !== previous ||
        currentAttempt() !== original
      )
        return;
      if (original) requests.dismiss("save");
      client.setQueryData<ProviderDraft | null>(key, (current) =>
        current === previous ? providerDraft(result) : current,
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
              : "Could not load the scheduling source.",
        });
    } finally {
      if (owner.controller === controller) owner.controller = null;
    }
  }
  function setFields(fields: Partial<ProviderDraft["fields"]>) {
    if (!requests.isActive() || currentAttempt() || owner.controller) return;
    client.setQueryData<ProviderDraft | null>(key, (current) =>
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
    const { provider, url, label } = current.fields;
    const parsed = scheduleProviderCommandSchema.safeParse({
      orgId: scope.orgId,
      userId: scope.userId,
      requestId: createLocalRequestUuid(),
      expectedRevision: current.base.revision,
      config: {
        provider,
        url: provider === "native" ? "" : url,
        label: provider === "other" ? label : "",
      },
    });
    if (!parsed.success) {
      setLoad({
        owner,
        kind: "failed",
        message:
          "Enter a valid HTTPS workspace URL and a platform name of at most 80 characters.",
      });
      return;
    }
    setLoad({ owner, kind: "idle" });
    requests.start(parsed.data, "Scheduling source");
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
    client.setQueryData<ProviderDraft | null>(key, null);
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
    refresh: () => requests.refresh("save"),
  };
}
