import { z } from "zod";
import { rundownItemSchema } from "./rundown-schema";
const id = z.string().min(1).max(64);
// Match the relay's accepted item bounds before freezing an immutable command.
const templateItem = rundownItemSchema.superRefine((item, ctx) => {
  const types = [
    "segment",
    "song",
    "header",
    "prayer",
    "announcement",
    "offering",
    "custom",
  ];
  const valid =
    item.id.trim().length > 0 &&
    item.id.length <= 128 &&
    item.title.length <= 500 &&
    types.includes(item.type) &&
    ["upcoming", "live", "complete"].includes(item.status) &&
    Number.isSafeInteger(item.duration) &&
    item.duration >= 0 &&
    item.duration <= 604800000 &&
    item.notes.length <= 20000 &&
    item.assignee.length <= 500 &&
    item.cue.length <= 2000 &&
    (item.lowerThirdId === undefined || item.lowerThirdId.length <= 128) &&
    [
      item.scheduledStart,
      item.expectedEnd,
      item.actualStart,
      item.actualEnd,
    ].every((value) => value == null || value.length <= 64);
  if (!valid)
    ctx.addIssue({
      code: "custom",
      message: "Review the rundown item before saving a template.",
    });
});
export const templateCopySchema = z.object({
  serviceName: z.string().max(120),
  scheduledStartTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .or(z.literal("")),
  items: z
    .array(templateItem)
    .max(500)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Rundown items must have distinct IDs.",
    )
    .transform((items) =>
      items.map((item, sortOrder) => ({
        ...item,
        sortOrder,
        status: "upcoming",
        actualStart: null,
        actualEnd: null,
      })),
    ),
});
export const templateSizeError =
  "This template copy is too large to send. Shorten item notes or split the rundown before capturing it again.";
function fitsMobileBody(value: unknown) {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const code = character.charCodeAt(0);
    bytes +=
      character.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes > 3_250_000) return false;
  }
  return true;
}
export const templateSaveCommandSchema = templateCopySchema
  .extend({
    orgId: id,
    userId: id,
    showId: id,
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(fitsMobileBody, templateSizeError);
export const templateSaveReplySchema = z.object({
  orgId: id,
  userId: id,
  showId: id,
  requestId: z.uuid(),
  outcome: z.enum(["applied", "cancelled", "conflict", "removed"]),
});
export type TemplateCopyInput = z.input<typeof templateCopySchema>;
export type TemplateCopy = z.infer<typeof templateCopySchema>;
export type TemplateSaveCommand = z.infer<typeof templateSaveCommandSchema>;
export type TemplateSaveReply = z.infer<typeof templateSaveReplySchema>;
export type TemplateSaveDraft = {
  showId: string;
  name: string;
  copy: TemplateCopy;
};
