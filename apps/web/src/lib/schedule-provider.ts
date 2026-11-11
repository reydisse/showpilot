import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { scheduleProviderCommandSchema } from "./schedule-provider-contract";
import {
  readScheduleProvider,
  writeScheduleProvider,
} from "./schedule-provider.server";

export const getScheduleProvider = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }).strict(), input),
  )
  .handler(({ data }) => readScheduleProvider(getRequestHeaders(), data.orgId));
export const saveScheduleProvider = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseOrThrow(scheduleProviderCommandSchema, input),
  )
  .handler(({ data }) => writeScheduleProvider(getRequestHeaders(), data));
