import type React from "react";
import { refreshRetainedResult } from "@/lib/retained-refresh";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { sendScheduleReminders } from "@/lib/schedule-reminder";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  scheduleReminderResultSchema,
  type ReminderTarget,
  type ScheduleReminderCommand,
  type ScheduleReminderResult,
} from "@/lib/schedule-reminder-contract";

type Attempt =
  | {
      kind: "pending";
      command: ScheduleReminderCommand;
      previous: ScheduleReminderResult | null;
    }
  | {
      kind: "failed";
      command: ScheduleReminderCommand;
      previous: ScheduleReminderResult | null;
      at: number;
    }
  | {
      kind: "confirmed";
      command: ScheduleReminderCommand;
      result: ScheduleReminderResult;
      refresh: "pending" | "done" | "failed";
      at: number;
    };
const keyFor = (
  command: Pick<ScheduleReminderCommand, "orgId" | "userId" | "target">,
) => [
  "schedule-reminder",
  command.userId,
  command.orgId,
  command.target.kind,
  command.target.id,
];
async function refreshResult(
  client: QueryClient,
  command: ScheduleReminderCommand,
  result: ScheduleReminderResult,
  refresh: () => Promise<void>,
  retry = false,
) {
  return refreshRetainedResult<Attempt>({
    client,
    key: keyFor(command),
    refresh,
    begin: (current) => {
      if (
        !current ||
        current.command.requestId !== command.requestId ||
        (current.kind === "confirmed" && current.refresh === "pending")
      )
        return null;
      if (
        retry &&
        (current.kind !== "confirmed" || current.refresh !== "failed")
      )
        return null;
      const confirmed =
        retry && current.kind === "confirmed" ? current.result : result;
      return {
        pending: {
          kind: "confirmed",
          command,
          result: confirmed,
          refresh: "pending",
          at: Date.now(),
        },
        done: {
          kind: "confirmed",
          command,
          result: confirmed,
          refresh: "done",
          at: Date.now(),
        },
        failed: () => ({
          kind: "confirmed",
          command,
          result: confirmed,
          refresh: "failed",
          at: Date.now(),
        }),
      };
    },
  });
}

async function execute(
  client: QueryClient,
  command: ScheduleReminderCommand,
  refresh: () => Promise<void>,
) {
  const key = keyFor(command),
    old = client.getQueryData<Attempt>(key);
  if (
    old?.kind === "pending" ||
    (old?.kind === "confirmed" && old.refresh === "pending")
  )
    return;
  const previous =
    old?.kind === "confirmed" ? old.result : (old?.previous ?? null);
  client.setQueryData<Attempt>(key, () => ({
    kind: "pending",
    command,
    previous,
  }));
  try {
    const result = await runRouteLoad(
      async (controller) => {
        const value = scheduleReminderResultSchema.parse(
          await sendScheduleReminders({
            data: command,
            signal: controller.signal,
          }),
        );
        controller.signal.throwIfAborted();
        if (
          value.orgId !== command.orgId ||
          value.userId !== command.userId ||
          value.requestId !== command.requestId
        )
          throw new Error("Reminder reply does not match this request.");
        return value;
      },
      undefined,
      15_000,
    );
    await refreshResult(client, command, result, refresh);
  } catch {
    client.setQueryData<Attempt>(key, () => ({
      kind: "failed",
      command,
      previous,
      at: Date.now(),
    }));
  }
}
const button =
  "min-h-11 rounded-lg border border-fire-500/25 px-3 py-2 text-xs text-fire-400 focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
export function ReminderControl({
  orgId,
  target,
  label,
  disabled = false,
  onChanged,
  className,
  icon,
}: {
  orgId: string;
  target: ReminderTarget;
  label: string;
  disabled?: boolean;
  onChanged: () => Promise<void>;
  /** Overrides the idle button style; retry/review states keep the default. */
  className?: string;
  icon?: React.ReactNode;
}) {
  const { user } = useRouteContext({ from: "/$slug" });
  const client = useQueryClient();
  const scope = { orgId, userId: user.id, target };
  const { data: attempt = null } = useQuery<Attempt | null>({
    queryKey: keyFor(scope),
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const pending =
    attempt?.kind === "pending" ||
    (attempt?.kind === "confirmed" && attempt.refresh === "pending");
  const result =
    attempt?.kind === "confirmed" ? attempt.result : attempt?.previous;
  const failedItems =
    result?.items.filter(
      (item) => item.email === "failed" && item.reason !== "status-check-failed",
    ) ?? [];
  const retryable = result?.items.some((item) =>
    ["failed", "uncertain", "sending", "unavailable"].includes(item.email),
  );
  const review = result?.items.some(
    (item) => item.email === "expired" || item.email === "changed",
  );
  const start = () => {
    if (!pending && !disabled)
      void execute(
        client,
        { ...scope, requestId: crypto.randomUUID() },
        onChanged,
      );
  };
  return (
    <div className="min-w-0 space-y-2 text-xs normal-case">
      {(!attempt || pending) && (
        <button
          type="button"
          className={className ?? button}
          disabled={disabled || pending}
          aria-busy={pending}
          onClick={start}
        >
          {icon}
          {label}
        </button>
      )}
      {attempt?.kind === "failed" && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-500/30 p-2"
        >
          <p>
            Some reminders could not be sent.</p>
          <Time at={attempt.at} />
          <button
            type="button"
            className={button}
            onClick={() => void execute(client, attempt.command, onChanged)}
          >
            Retry reminders
          </button>
        </div>
      )}
      {result?.items.length === 0 && (
        <p role="status">No pending assignments in this selection.</p>
      )}
      {failedItems.length > 0 && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-500/30 p-2"
        >
          <p>Some reminders could not be sent.</p>
          <ul className="list-disc pl-4">
            {failedItems.map((item) => (
              <li key={item.id} className="break-words">
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {attempt?.kind === "confirmed" && attempt.refresh === "failed" && (
        <div role="alert" className="space-y-2">
          <p>
            Schedule could not be updated.</p>
          <button
            type="button"
            className={button}
            onClick={() =>
              void refreshResult(
                client,
                attempt.command,
                attempt.result,
                onChanged,
                true,
              )
            }
          >
            Retry refresh
          </button>
        </div>
      )}
      {attempt?.kind === "confirmed" && attempt.refresh === "done" && (
        <>
          {retryable && (
            <button
              type="button"
              className={button}
              onClick={() => void execute(client, attempt.command, onChanged)}
            >
              Retry reminders
            </button>
          )}
          {review && (
            <p className="text-board-muted">
              Review the current assignments before sending again.
            </p>
          )}
          {!retryable && (
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={start}
            >
              {review
                ? "Send new reminders after review"
                : "Send another reminder"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
function Time(_props: { at: number }) {
  return (
    null
  );
}
