import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { tmStreamCommandSchema } from "./tm-stream-contract";
import { readTmStream, executeTmStream } from "./tm-stream.server";
export const getTmStreamState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(({ data }) => readTmStream(data.orgId, getRequestHeaders()));
export const writeTmStream = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(tmStreamCommandSchema, data))
  .handler(({ data }) => executeTmStream(data, getRequestHeaders()));
