import { z } from "zod";
import { idSchema } from "./validation";

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const profileRequestSchema = z
  .object({
    userId: idSchema,
    requestId: z.string().uuid(),
    expectedRevision: revision,
  })
  .strict();
export const profileNameCommandSchema = profileRequestSchema.extend({
  kind: z.literal("name"),
  name: z.string().trim().min(1).max(50),
});
export const profilePhotoCommandSchema = profileRequestSchema.extend({
  kind: z.literal("photo"),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const profileCommandSchema = z.discriminatedUnion("kind", [
  profileNameCommandSchema,
  profilePhotoCommandSchema,
]);
export type ProfileCommand = z.infer<typeof profileCommandSchema>;
export const profileStateSchema = z.object({
  userId: idSchema,
  name: z.string(),
  image: z.string().nullable(),
  revision,
});
export type ProfileState = z.infer<typeof profileStateSchema>;
export const profileResultSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(["applied", "conflict", "superseded"]),
  state: profileStateSchema,
});
