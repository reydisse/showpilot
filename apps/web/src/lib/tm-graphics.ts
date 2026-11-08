import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { graphicsClearCommandSchema } from "./graphics-clear-contract";
import { readTmGraphics, clearTmGraphics } from "./tm-graphics.server";
export const getTmGraphicsState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(({ data }) => readTmGraphics(data.orgId, getRequestHeaders()));
export const writeTmGraphicsClear = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(graphicsClearCommandSchema, data),
  )
  .handler(({ data }) => clearTmGraphics(data, getRequestHeaders()));
