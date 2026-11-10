import { z } from "zod";
import { idSchema } from "./validation";

export const chatHistoryClearSchema = z
  .object({
    orgId: idSchema,
    requestId: z.uuid(),
    confirmName: z.string().min(1).max(200),
  })
  .strict();
export type ChatHistoryClear = z.infer<typeof chatHistoryClearSchema>;
export const chatHistoryClearResultSchema = z
  .object({
    requestId: z.uuid(),
    cutoff: z.number().int(),
    rooms: z.array(z.object({ roomId: z.string(), cleared: z.boolean() })),
  })
  .strict();
export type ChatHistoryClearResult = z.infer<
  typeof chatHistoryClearResultSchema
>;
export const chatRoomClearSchema = z
  .object({
    ...chatHistoryClearSchema.shape,
    roomId: z.string().min(1).max(500),
    deadline: z.number().int(),
    authority: z
      .object({ orgId: idSchema, userId: idSchema, sessionId: idSchema })
      .strict(),
  })
  .strict();
export type ChatRoomClear = z.infer<typeof chatRoomClearSchema>;
export const chatClearReceiptSchema = z.object({
  confirmName: z.string(),
  cutoff: z.number().int(),
  rooms: z
    .string()
    .transform((value) => z.array(z.string()).parse(JSON.parse(value))),
});
