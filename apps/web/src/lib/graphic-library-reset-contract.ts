import { z } from "zod";
import { idSchema } from "./validation";

export const graphicLibraryResetSchema = z.object({
  orgId: idSchema,
  requestId: z.uuid(),
  confirmName: z.string().min(1).max(200),
}).strict();
export type GraphicLibraryReset = z.infer<typeof graphicLibraryResetSchema>;
export const graphicLibraryResetResultSchema = z.object({
  requestId: z.uuid(),
  deletedCount: z.number().int().nonnegative(),
}).strict();
