import { z } from "zod";
import { idSchema } from "./validation";
const base = { orgId: idSchema, requestId: z.uuid() };
const target = { id: idSchema, revision: z.number().int().nonnegative() };
const fields = {
  name: z.string().trim().min(1).max(200),
  // Existing teams may use CSS color names or tokens as well as palette hex values.
  color: z.string().trim().min(1).max(30),
};
export const kioskTeamCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("create"), ...fields }).strict(),
  z
    .object({ ...base, action: z.literal("update"), ...target, ...fields })
    .strict(),
  z.object({ ...base, action: z.literal("delete"), ...target }).strict(),
  z
    .object({
      ...base,
      action: z.literal("set-member"),
      ...target,
      userId: idSchema,
      role: z.enum(["member", "lead"]),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("remove-member"),
      ...target,
      userId: idSchema,
    })
    .strict(),
]);
export type KioskTeamCommand = z.infer<typeof kioskTeamCommandSchema>;
export const kioskTeamResultSchema = z
  .object({
    id: idSchema,
    requestId: z.uuid(),
    outcome: z.enum(["applied", "conflict"]),
  })
  .strict();
export type KioskTeamResult = z.infer<typeof kioskTeamResultSchema>;
