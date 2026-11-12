import { z } from "zod";
import { isServiceDate } from "./service-time";

const id = z.string().min(1).max(64);
const date = z.string().refine(isServiceDate, "Use a real YYYY-MM-DD date.");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z
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
  }, "Choose a valid timezone.");
export const showCreationCommandSchema = z
  .object({
    orgId: id,
    userId: id,
    requestId: id,
    serviceDate: date,
    timeZone,
    name: z.string().trim().min(1).max(120),
    location: z.string().trim().max(240),
    startTime: clock.optional(),
    callTime: clock.optional(),
    inventoryId: id.optional(),
    copyFrom: date.optional(),
    copyFromShowId: id.optional(),
  })
  .refine((value) => Boolean(value.copyFrom) === Boolean(value.copyFromShowId))
  .refine((value) => !value.inventoryId || !value.copyFromShowId);
export const showCreationReplySchema = z.object({
  orgId: id,
  userId: id,
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("created"),
      result: z.object({ ok: z.literal(true), showId: id, serviceDate: date }),
    }),
    z.object({ kind: z.literal("cancelled") }),
    z.object({ kind: z.literal("removed") }),
  ]),
});
export type ShowCreationCommand = z.infer<typeof showCreationCommandSchema>;
export type ShowCreationReply = z.infer<typeof showCreationReplySchema>;
export type ShowCreationSource =
  | { kind: "blank" }
  | { kind: "inventory"; id: string; name: string }
  | { kind: "show"; id: string; name: string; serviceDate: string };
export type ShowCreationDraft = {
  serviceDate: string;
  timeZone: string;
  name: string;
  location: string;
  startTime: string;
  callTime: string;
  source: ShowCreationSource;
};
export function creationCommand(
  scope: { orgId: string; userId: string },
  requestId: string,
  draft: ShowCreationDraft,
) {
  return showCreationCommandSchema.safeParse({
    ...scope,
    requestId,
    ...draft,
    startTime: draft.startTime || undefined,
    callTime: draft.callTime || undefined,
    ...(draft.source.kind === "inventory"
      ? { inventoryId: draft.source.id }
      : draft.source.kind === "show"
        ? {
            copyFrom: draft.source.serviceDate,
            copyFromShowId: draft.source.id,
          }
        : {}),
  });
}
export function nextShowStartTime(value: string) {
  if (!clock.safeParse(value).success) return "10:00";
  const [hours, minutes] = value.split(":").map(Number);
  const next = Math.min(hours * 60 + minutes + 60, 23 * 60 + 59);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}
