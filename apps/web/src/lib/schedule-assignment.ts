import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { scheduleAssignmentCommandSchema } from "./schedule-assignment-contract";
import {
  readScheduleAssignment,
  writeScheduleAssignment,
} from "./schedule-assignment.server";

export const getScheduleAssignment = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }).strict(), input),
  )
  .handler(({ data }) =>
    readScheduleAssignment(getRequestHeaders(), data.orgId, data.id),
  );
export const changeScheduleAssignment = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseOrThrow(scheduleAssignmentCommandSchema, input),
  )
  .handler(({ data }) => writeScheduleAssignment(getRequestHeaders(), data));
