import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  runMobileOperation,
  MobileOperationTimeoutError,
} from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";

type Identity = { orgId: string; userId: string; requestId: string };
export type RetainedAttempt<Command, Result> = {
  command: Command;
  label: string;
} & (
  | { kind: "pending"; previous: Result | null }
  | { kind: "failed"; previous: Result | null; message: string }
  | {
      kind: "confirmed";
      result: Result;
      refresh: "idle" | "pending" | "failed" | "done";
      at: number;
      message?: string;
    }
);

/** A command's identity and acknowledgement survive screen navigation. Domain
 * hooks decide which results are retryable and which can be dismissed. */
export function useRetainedRequests<
  Command extends Identity,
  Result extends Identity,
>(
  scope: { orgId: string; userId: string },
  options: {
    family: string;
    scopeKey?: string;
    review?: (command: Command, signal: AbortSignal) => Promise<Result>;
    enabled: boolean;
    slot: (command: Command) => string;
    send: (command: Command, signal: AbortSignal) => Promise<Result>;
    parseResult: (input: unknown) => Result;
    retryable: (result: Result) => boolean;
    dismissible: (result: Result) => boolean;
    failureMessage: string;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  type Attempt = RetainedAttempt<Command, Result>;
  type Work = Record<string, Attempt>;
  const client = useQueryClient();
  const key =
      options.scopeKey === undefined
        ? [options.family, scope.userId, scope.orgId]
        : [options.family, scope.userId, scope.orgId, options.scopeKey],
    hash = hashKey(key);
  const initial = useMemo<Work>(() => ({}), [hash]);
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Work>(key);
  const work = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => read() ?? initial,
    () => read() ?? initial,
  );
  const owner = useMemo(
    () => ({ mounted: false, refreshes: new Map<string, AbortController>() }),
    [hash, options.enabled],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => {
    owner.mounted = options.enabled;
    return () => {
      owner.mounted = false;
      for (const controller of owner.refreshes.values()) controller.abort();
    };
  }, [owner, options.enabled]);
  const active = () => owner.mounted && currentOwner.current === owner;
  const put = (slot: string, expected: Attempt | undefined, next: Attempt) =>
    client.setQueryData<Work>(key, (current) =>
      current && current[slot] === expected
        ? { ...current, [slot]: next }
        : current,
    )?.[slot];

  async function refresh(slot: string) {
    const attempt = read()?.[slot];
    if (
      !active() ||
      attempt?.kind !== "confirmed" ||
      attempt.refresh === "pending"
    )
      return;
    const controller = new AbortController();
    owner.refreshes.set(slot, controller);
    const claim = put(slot, attempt, {
      ...attempt,
      refresh: "pending",
      message: undefined,
    });
    try {
      await runMobileOperation(
        async (child) => {
          await options.refresh(child.signal);
          if (child.signal.aborted) throw new Error("Refresh cancelled.");
        },
        controller.signal,
        12000,
      );
      put(slot, claim, { ...attempt, refresh: "done", message: undefined });
    } catch (error) {
      put(slot, claim, {
        ...attempt,
        refresh: active() ? "failed" : "idle",
        message: active()
          ? message(error, "Schedule could not refresh.")
          : undefined,
      });
    } finally {
      if (owner.refreshes.get(slot) === controller)
        owner.refreshes.delete(slot);
    }
  }
  async function execute(command: Command, label: string, send = options.send) {
    const slot = options.slot(command),
      current = read()?.[slot];
    if (
      !active() ||
      !read() ||
      command.orgId !== scope.orgId ||
      command.userId !== scope.userId ||
      current?.kind === "pending" ||
      (current?.kind === "confirmed" && current.refresh === "pending")
    )
      return;
    const previous =
      current?.kind === "confirmed"
        ? current.result
        : (current?.previous ?? null);
    const claim = put(slot, current, {
      kind: "pending",
      command,
      label,
      previous,
    });
    try {
      const result = await runMobileOperation(
        async (controller) =>
          options.parseResult(await send(command, controller.signal)),
        undefined,
        15000,
      );
      if (
        result.orgId !== command.orgId ||
        result.userId !== command.userId ||
        result.requestId !== command.requestId
      )
        throw new Error("Reply does not match this request.");
      if (read()?.[slot] !== claim) return;
      put(slot, claim, {
        kind: "confirmed",
        command,
        label,
        result,
        refresh: "idle",
        at: Date.now(),
      });
      if (active()) await refresh(slot);
    } catch (error) {
      put(slot, claim, {
        kind: "failed",
        command,
        label,
        previous,
        message: message(error, options.failureMessage),
      });
    }
  }
  function start(command: Command, label: string, another = false) {
    if (!active() || !read()) return;
    const previous = read()?.[options.slot(command)];
    if (
      previous &&
      (!another ||
        previous.kind !== "confirmed" ||
        previous.refresh !== "done" ||
        options.retryable(previous.result))
    )
      return;
    void execute(command, label);
  }
  return {
    work,
    isActive: active,
    review: (slot: string) => {
      const attempt = read()?.[slot];
      if (attempt?.kind === "failed" && options.review)
        void execute(attempt.command, attempt.label, options.review);
    },
    start: (command: Command, label: string) => start(command, label),
    another: (slot: string) => {
      const attempt = read()?.[slot];
      if (attempt)
        start(
          { ...attempt.command, requestId: createLocalRequestUuid() },
          attempt.label,
          true,
        );
    },
    retry: (slot: string) => {
      const attempt = read()?.[slot];
      if (
        attempt?.kind === "failed" ||
        (attempt?.kind === "confirmed" &&
          attempt.refresh === "done" &&
          options.retryable(attempt.result))
      )
        void execute(attempt.command, attempt.label);
    },
    refresh: (slot: string) => void refresh(slot),
    dismiss: (slot: string) => {
      const attempt = read()?.[slot];
      if (
        !active() ||
        attempt?.kind !== "confirmed" ||
        attempt.refresh !== "done" ||
        !options.dismissible(attempt.result)
      )
        return;
      client.setQueryData<Work>(key, (current) => {
        if (!current || current[slot] !== attempt) return current;
        const next = { ...current };
        delete next[slot];
        return next;
      });
    },
  };
}
function message(error: unknown, fallback: string) {
  return error instanceof Error &&
    !(error instanceof MobileOperationTimeoutError)
    ? error.message
    : fallback;
}
