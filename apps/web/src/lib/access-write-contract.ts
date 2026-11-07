import { z } from "zod";
import {
  ACCESS_CAPABILITY_IDS,
  isGrantablePermission,
} from "./access-capabilities";
import { idSchema, serviceDateSchema } from "./validation";
const common = {
  orgId: idSchema,
  requestId: z.uuid().optional(),
  expectedWeekStart: serviceDateSchema.optional(),
};
export const grantAccessSchema = z.object({
  ...common,
  userId: idSchema,
  capability: z.union([z.enum(ACCESS_CAPABILITY_IDS), z.literal("custom")]),
  permissions: z
    .array(z.string().refine(isGrantablePermission))
    .max(32)
    .default([])
    .transform((value) => [...new Set(value)].sort()),
  duration: z.enum(["this-week", "until-revoked"]),
  reason: z.string().trim().max(240).default(""),
});
export const revokeAccessSchema = z.object({ ...common, grantId: idSchema });
export const accessWriteSchema = z.discriminatedUnion("kind", [
  grantAccessSchema.extend({ kind: z.literal("grant") }),
  revokeAccessSchema.extend({ kind: z.literal("revoke") }),
]);
export type AccessWrite = z.infer<typeof accessWriteSchema>;
export const accessWriteResultSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  requestId: z.string(),
  kind: z.enum(["grant", "revoke"]),
  state: z.enum(["active", "revoked", "expired", "missing"]),
  notification: z.enum(["pending", "created", "superseded"]),
});
export type AccessWriteResult = z.infer<typeof accessWriteResultSchema>;
export const accessNoticeSchema = z.object({
  requestId: z.string(),
  kind: z.enum(["grant", "revoke"]),
  grantId: z.string(),
  title: z.string(),
  message: z.string(),
});
export type AccessNotice = z.infer<typeof accessNoticeSchema>;
