import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { equipmentCommandSchema } from "./equipment-command-contract";
import {
  readEquipmentState,
  writeEquipmentCommand,
} from "./equipment-command.server";
export const getEquipmentState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(({ data }) => readEquipmentState(getRequestHeaders(), data.orgId));
export const commandEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(equipmentCommandSchema, data))
  .handler(({ data }) =>
    writeEquipmentCommand(getRequestHeaders(), data, "write"),
  );
export const reviewEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(equipmentCommandSchema, data))
  .handler(({ data }) =>
    writeEquipmentCommand(getRequestHeaders(), data, "review"),
  );
