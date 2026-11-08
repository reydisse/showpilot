import { z } from "zod";
import {
  assignmentRetryable,
  scheduleAssignmentCommandSchema,
  scheduleAssignmentResultSchema,
  type ScheduleAssignmentCommand,
  type ScheduleAssignmentResult,
} from "./assignment-recovery";
import {
  runMobileOperation,
  MobileOperationTimeoutError,
} from "./request-deadline";

export type TeamDraft = {
  showId: string;
  serviceDate: string;
  showName: string;
  timeZone: string;
  department: string;
  rows: { crewMemberId: string; name: string; email: string; role: string }[];
};
export const teamCommandSchema = z
  .object({
    orgId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64),
    requestId: z.uuid(),
    rows: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            command: scheduleAssignmentCommandSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine(
    (value) =>
      value.rows.every(
        (row) =>
          row.command.orgId === value.orgId &&
          row.command.userId === value.userId &&
          row.command.operation.kind === "create" &&
          row.command.operation.fields.crewMemberId,
      ),
    "Review the selected people and workspace.",
  )
  .refine(
    (value) =>
      new Set(value.rows.map((row) => row.command.requestId)).size ===
      value.rows.length,
    "Each position needs its own request.",
  );
export type TeamCommand = z.infer<typeof teamCommandSchema>;
export const teamResultSchema = z
  .object({
    orgId: z.string(),
    userId: z.string(),
    requestId: z.uuid(),
    rows: z.array(
      z
        .object({
          requestId: z.uuid(),
          name: z.string(),
          result: scheduleAssignmentResultSchema.nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type TeamResult = z.infer<typeof teamResultSchema>;
export const teamRetryable = (result: TeamResult) =>
  result.rows.some((row) => !row.result || assignmentRetryable(row.result));

/** Each row has its own durable server receipt. A retry never rebuilds the
 * selection from today's roster or resends a known successful invitation. */
export async function saveTeamRows(
  command: TeamCommand,
  previous: TeamResult | null,
  send: (
    command: ScheduleAssignmentCommand,
    review: boolean,
    signal: AbortSignal,
  ) => Promise<ScheduleAssignmentResult>,
  review: boolean,
  signal: AbortSignal,
): Promise<TeamResult> {
  const rows = await Promise.all(
    command.rows.map(async (row) => {
      const known = previous?.rows.find(
        (item) => item.requestId === row.command.requestId,
      );
      if (known?.result && !assignmentRetryable(known.result)) return known;
      try {
        const result = await runMobileOperation(
          async (controller) =>
            scheduleAssignmentResultSchema.parse(
              await send(row.command, review, controller.signal),
            ),
          signal,
          12000,
        );
        if (
          result.orgId !== command.orgId ||
          result.userId !== command.userId ||
          result.requestId !== row.command.requestId
        )
          throw new Error("Reply does not match this position.");
        return {
          requestId: row.command.requestId,
          name: row.name,
          result,
          error: null,
        };
      } catch (error) {
        return {
          requestId: row.command.requestId,
          name: row.name,
          result: known?.result ?? null,
          error:
            error instanceof Error &&
            !(error instanceof MobileOperationTimeoutError)
              ? error.message
              : "This position could not be confirmed.",
        };
      }
    }),
  );
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    rows,
  };
}
