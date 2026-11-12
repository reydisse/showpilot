import {
  useRetainedRequests,
  type RetainedAttempt,
} from "./use-retained-requests";
import {
  scheduleReminderCommandSchema,
  scheduleReminderResultSchema,
  type ReminderTarget,
  type ScheduleReminderCommand,
  type ScheduleReminderResult,
} from "../lib/reminder-recovery";
import { createLocalRequestUuid } from "../lib/request-id";
export type ReminderAttempt = RetainedAttempt<
  ScheduleReminderCommand,
  ScheduleReminderResult
>;
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
  const requests = useRetainedRequests(scope, {
    ...options,
    family: "mobile-schedule-reminders",
    slot: (command) => reminderSlot(command.target),
    parseResult: (input) => scheduleReminderResultSchema.parse(input),
    retryable: reminderRetryable,
    dismissible: (result) =>
      result.items.every((item) => item.email === "accepted"),
    failureMessage: "Reminder delivery could not be confirmed.",
  });
  return {
    ...requests,
    start: (target: ReminderTarget, label: string) =>
      requests.start(
        scheduleReminderCommandSchema.parse({
          ...scope,
          requestId: createLocalRequestUuid(),
          target,
        }),
        label,
      ),
  };
}
