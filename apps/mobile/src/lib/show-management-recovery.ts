import { z } from "zod";
import { isServiceDate, serviceWallTimeInput } from "./service-time";
const id = z.string().min(1).max(64);
const instant = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const clock = z.union([
  z.literal(""),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
]);
const date = z.string().refine(isServiceDate);
const identity = z.object({ orgId: id, userId: id, requestId: id, showId: id });
export const showManagementFieldsSchema = z.object({
  serviceDate: date,
  name: z.string().trim().min(1).max(120),
  location: z.string().trim().max(240),
  startTime: clock,
  callTime: clock,
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
});
export const showManagementCommandSchema = z.discriminatedUnion("kind", [
  identity.extend({
    ...showManagementFieldsSchema.shape,
    kind: z.literal("edit"),
    expectedUpdatedAt: instant,
  }),
  identity.extend({ kind: z.literal("delete"), expectedUpdatedAt: instant }),
]);
export const showSnapshotSchema = z.object({
  id,
  serviceDate: date,
  name: z.string(),
  location: z.string(),
  updatedAt: instant,
  scheduledStartTime: instant.nullable(),
  scheduledCallTime: instant.nullable(),
});
export const showManagementReplySchema = z.discriminatedUnion("kind", [
  identity.extend({
    kind: z.literal("edit"),
    result: z.object({
      requestId: id,
      showId: id,
      outcome: z.enum([
        "applied",
        "superseded",
        "conflict",
        "cancelled",
        "removed",
      ]),
      snapshot: showSnapshotSchema.nullable(),
    }),
  }),
  identity.extend({
    kind: z.literal("delete"),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), message: z.string().min(1) }),
    ]),
  }),
]);
export const showManagementReadSchema = z.object({
  orgId: id,
  userId: id,
  showId: id,
  timeZone: showManagementFieldsSchema.shape.timeZone,
  snapshot: showSnapshotSchema.nullable(),
});
export type ShowManagementCommand = z.infer<typeof showManagementCommandSchema>;
export type ShowManagementReply = z.infer<typeof showManagementReplySchema>;
export type ShowManagementRead = z.infer<typeof showManagementReadSchema>;
export type ShowSnapshot = z.infer<typeof showSnapshotSchema>;
export type ShowManagementDraft = {
  mode: "edit" | "delete";
  showId: string;
  base: ShowSnapshot;
  fields: z.infer<typeof showManagementFieldsSchema>;
};
export function showDraftFromSnapshot(
  mode: ShowManagementDraft["mode"],
  snapshot: ShowSnapshot,
  timeZone: string,
): ShowManagementDraft {
  return {
    mode,
    showId: snapshot.id,
    base: snapshot,
    fields: {
      serviceDate: snapshot.serviceDate,
      name: snapshot.name,
      location: snapshot.location,
      timeZone,
      startTime: serviceWallTimeInput(snapshot.scheduledStartTime, timeZone),
      callTime: serviceWallTimeInput(snapshot.scheduledCallTime, timeZone),
    },
  };
}
