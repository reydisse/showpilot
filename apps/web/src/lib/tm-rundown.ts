import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { tmRundownCommandSchema } from "./tm-rundown-contract";
import { readTmRundown, executeTmRundown } from "./tm-rundown.server";
export const getTmRundownState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(({ data }) => readTmRundown(data.orgId, getRequestHeaders()));
export const writeTmRundown = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(tmRundownCommandSchema, data))
  .handler(({ data }) => executeTmRundown(data, getRequestHeaders()));
