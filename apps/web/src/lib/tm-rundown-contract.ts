import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";
export const tmRundownActionSchema = z.enum([
  "timer-start",
  "timer-stop",
  "timer-add",
  "timer-subtract",
  "rundown-next",
  "rundown-previous",
  "lyrics-on",
  "lyrics-off",
]);
export const tmRundownTargetSchema = z.object({
  showId: idSchema.nullable(),
  serviceDate: serviceDateSchema,
});
export const tmRundownCommandSchema = z
  .object({
    orgId: idSchema,
    requestId: z.string().uuid(),
    action: tmRundownActionSchema,
    target: tmRundownTargetSchema,
    expectedRevision: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const item = z.object({ id: idSchema, title: z.string() });
export const tmRundownSnapshotSchema = z.object({
  target: tmRundownTargetSchema,
  revision: z.number().int().nonnegative(),
  serverTime: z.number(),
  initialized: z.boolean(),
  timer: z.object({
    playback: z.enum(["play", "pause", "stop"]),
    elapsed: z.number(),
  }),
  currentItem: item.nullable(),
  nextItem: item.nullable(),
  firstItem: item.nullable(),
  hasPrevious: z.boolean(),
  lyricsEnabled: z.boolean(),
  canControl: z.boolean(),
  blockedReason: z.string().nullable(),
});
export const tmRundownResultSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum([
    "applied",
    "revision-conflict",
    "expired",
    "target-changed",
    "unavailable",
  ]),
});
export type TmRundownCommand = z.infer<typeof tmRundownCommandSchema>;
export type TmRundownAction = z.infer<typeof tmRundownActionSchema>;
export type TmRundownSnapshot = z.infer<typeof tmRundownSnapshotSchema>;
export type TmRundownResult = z.infer<typeof tmRundownResultSchema>;
