import { z } from "zod";
import { idSchema } from "./validation";

export const firstSessionItemSchema = z.enum([
  "rename-item",
  "connect-device",
  "invite-teammate",
  "open-board",
]);
const storedSchema = z.object({
  dismissed: z.boolean().default(false),
  completed: z.array(z.string().max(50)).max(10).default([]),
  revision: z.uuid().optional(),
});
export function parseFirstSessionSnapshot(snapshot: string | null) {
  if (snapshot === null) return storedSchema.parse({});
  try {
    return storedSchema.parse(JSON.parse(snapshot));
  } catch {
    throw new Error(
      "Saved checklist progress could not be read. Retry without changing it.",
    );
  }
}
export const firstSessionStateSchema = z.object({
  show: z.boolean(),
  completed: z.array(z.string().max(50)).max(10),
  snapshot: z.string().max(2048).nullable(),
});
export type FirstSessionState = z.infer<typeof firstSessionStateSchema>;
export const firstSessionWriteSchema = z
  .object({
    orgId: idSchema,
    requestId: z.uuid(),
    expectedSnapshot: z.string().max(2048).nullable(),
    action: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("item"),
          item: firstSessionItemSchema,
          completed: z.boolean(),
        })
        .strict(),
      z.object({ kind: z.literal("dismiss") }).strict(),
    ]),
  })
  .strict();
export type FirstSessionWrite = z.infer<typeof firstSessionWriteSchema>;
export const firstSessionResultSchema = z.object({
  requestId: z.uuid(),
  outcome: z.enum(["applied", "conflict"]),
  state: firstSessionStateSchema,
});
export function firstSessionState(snapshot: string | null): FirstSessionState {
  const state = parseFirstSessionSnapshot(snapshot);
  return { show: !state.dismissed, completed: state.completed, snapshot };
}
