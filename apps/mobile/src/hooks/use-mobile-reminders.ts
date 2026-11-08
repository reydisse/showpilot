import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  scheduleReminderCommandSchema,
  scheduleReminderResultSchema,
  type ReminderTarget,
  type ScheduleReminderCommand,
  type ScheduleReminderResult,
} from "../lib/reminder-recovery";
import {
  runMobileOperation,
  MobileOperationTimeoutError,
} from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";

type Common = { command: ScheduleReminderCommand; label: string };
export type ReminderAttempt = Common &
  (
    | { kind: "pending"; previous: ScheduleReminderResult | null }
    | {
        kind: "failed";
        previous: ScheduleReminderResult | null;
        message: string;
      }
    | {
        kind: "confirmed";
        result: ScheduleReminderResult;
        refresh: "idle" | "pending" | "failed" | "done";
        at: number;
        message?: string;
      }
  );
type Work = Record<string, ReminderAttempt>;
export const reminderSlot = (target: ReminderTarget) =>
  `${target.kind}:${target.id}`;
export const reminderRetryable = (result: ScheduleReminderResult) =>
  result.items.some((item) =>
    ["failed", "uncertain", "sending", "unavailable"].includes(item.email),
  );

export function useMobileReminders(
  scope: { orgId: string; userId: string },
  options: {
    enabled: boolean;
    send: (
      command: ScheduleReminderCommand,
      signal: AbortSignal,
    ) => Promise<ScheduleReminderResult>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = ["mobile-schedule-reminders", scope.userId, scope.orgId],
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
  const put = (
    slot: string,
    expected: ReminderAttempt | undefined,
    next: ReminderAttempt,
  ) =>
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
          ? errorMessage(error, "Schedule could not refresh.")
          : undefined,
      });
    } finally {
      if (owner.refreshes.get(slot) === controller)
        owner.refreshes.delete(slot);
    }
  }
  async function execute(command: ScheduleReminderCommand, label: string) {
    const slot = reminderSlot(command.target),
      current = read()?.[slot];
    if (
      !active() ||
      !read() ||
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
          scheduleReminderResultSchema.parse(
            await options.send(command, controller.signal),
          ),
        undefined,
        15000,
      );
      if (
        result.orgId !== command.orgId ||
        result.userId !== command.userId ||
        result.requestId !== command.requestId
      )
        throw new Error("Reminder reply does not match this request.");
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
        message: errorMessage(
          error,
          "Reminder delivery could not be confirmed.",
        ),
      });
    }
  }
  function start(target: ReminderTarget, label: string, another = false) {
    if (!active() || !read()) return;
    const previous = read()?.[reminderSlot(target)];
    if (
      previous &&
      (!another ||
        previous.kind !== "confirmed" ||
        previous.refresh !== "done" ||
        reminderRetryable(previous.result))
    )
      return;
    const command = scheduleReminderCommandSchema.parse({
      ...scope,
      requestId: createLocalRequestUuid(),
      target,
    });
    void execute(command, label);
  }
  return {
    work,
    start: (target: ReminderTarget, label: string) => start(target, label),
    another: (slot: string) => {
      const attempt = read()?.[slot];
      if (attempt) start(attempt.command.target, attempt.label, true);
    },
    retry: (slot: string) => {
      const attempt = read()?.[slot];
      if (
        attempt?.kind === "failed" ||
        (attempt?.kind === "confirmed" &&
          attempt.refresh === "done" &&
          reminderRetryable(attempt.result))
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
        attempt.result.items.some((item) => item.email !== "accepted")
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
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error &&
    !(error instanceof MobileOperationTimeoutError)
    ? error.message
    : fallback;
}
