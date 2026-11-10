import { z } from "zod";
import { idSchema } from "./validation";
const fields = z.object({
  memberId: z
    .string()
    .trim()
    .min(1, "Badge ID is required")
    .max(128)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
  email: z
    .union([z.literal(""), z.email().max(254)])
    .transform((value) => value.trim().toLowerCase()),
  photoUrl: z.string().max(2_100_000),
});
const retry = { orgId: idSchema, requestId: z.uuid().optional() };
const revision = z.number().int().nonnegative().optional();
export const createCrewProfileSchema = fields.extend({
  ...retry,
  email: fields.shape.email.default(""),
  photoUrl: fields.shape.photoUrl.default(""),
});
export const updateCrewProfileSchema = z.object({
  ...retry,
  id: idSchema,
  expectedRevision: revision,
  updates: fields
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Choose a crew profile change before saving.",
    ),
});
export const deleteCrewProfileSchema = z.object({
  ...retry,
  id: idSchema,
  expectedRevision: revision,
});
export const crewProfileCommandSchema = z.discriminatedUnion("kind", [
  createCrewProfileSchema.extend({ kind: z.literal("create") }),
  updateCrewProfileSchema.extend({ kind: z.literal("update") }),
  deleteCrewProfileSchema.extend({ kind: z.literal("delete") }),
]);
export type CrewProfileCommand = z.infer<typeof crewProfileCommandSchema>;
export const crewRosterMemberSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  memberId: z.string(),
  name: z.string(),
  role: z.string(),
  email: z.string(),
  photoUrl: z.string(),
  profileRevision: z.number().int().nonnegative(),
  isOnline: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform(Boolean),
  createdAt: z.coerce.date(),
  lastCheckIn: z.coerce.date().nullable(),
  lastCheckOut: z.coerce.date().nullable(),
});
export type CrewRosterMember = z.infer<typeof crewRosterMemberSchema>;
export const crewProfileResultSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  kind: z.enum(["create", "update", "delete"]),
});
export type CrewProfileResult = z.infer<typeof crewProfileResultSchema>;
