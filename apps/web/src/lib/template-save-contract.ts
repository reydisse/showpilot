import { z } from "zod";
import { idSchema } from "./validation";
import { parseRelayRundownItems } from "./rundown-relay-payload";
const items = z
  .array(z.unknown())
  .max(500)
  .transform((value, ctx) => {
    const parsed = parseRelayRundownItems(value);
    if (!parsed) {
      ctx.addIssue({
        code: "custom",
        message: "Review the rundown items before saving a template.",
      });
      return z.NEVER;
    }
    return parsed.map((item, sortOrder) => ({
      ...item,
      sortOrder,
      status: "upcoming" as const,
      actualStart: null,
      actualEnd: null,
    }));
  });
export const templateSaveCommandSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    showId: idSchema,
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    serviceName: z.string().max(120),
    scheduledStartTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .or(z.literal("")),
    items,
  })
  .strict();
export type TemplateSaveCommand = z.infer<typeof templateSaveCommandSchema>;
export type TemplateSaveResult = Pick<
  TemplateSaveCommand,
  "orgId" | "userId" | "showId" | "requestId"
> & {
  outcome: "applied" | "cancelled" | "conflict" | "removed";
};
