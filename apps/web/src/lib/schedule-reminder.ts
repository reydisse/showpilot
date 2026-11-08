import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { parseOrThrow } from "./validation";
import { scheduleReminderCommandSchema } from "./schedule-reminder-contract";
import { runScheduleReminders } from "./schedule-reminder.server";
export const sendScheduleReminders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseOrThrow(scheduleReminderCommandSchema, input),
  )
  .handler(({ data }) => runScheduleReminders(getRequestHeaders(), data));
