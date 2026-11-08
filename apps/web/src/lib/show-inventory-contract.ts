import { z } from "zod";
import { idSchema } from "./validation";
export const inventoryDraftSchema = z.object({
  name: z.string().trim().min(1, "Enter a show name").max(120),
  description: z.string().trim().max(500).default(""),
  location: z.string().trim().max(240).default(""),
  defaultStartTime: z
    .union([
      z.literal(""),
      z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM"),
    ])
    .default(""),
  sourceTemplateId: z
    .union([idSchema, z.literal(""), z.null()])
    .optional()
    .transform((value) => value || null),
});
const version = z
  .string()
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Refresh inventory before changing it",
  );
export const inventoryCommandSchema = z.object({
  orgId: idSchema,
  userId: idSchema.optional(),
  requestId: idSchema,
  operation: z.discriminatedUnion("kind", [
    inventoryDraftSchema.extend({ kind: z.literal("create") }),
    z.object({
      kind: z.literal("archive"),
      id: idSchema,
      archived: z.boolean(),
      expectedUpdatedAt: version,
    }),
  ]),
});
export type InventoryCommand = z.infer<typeof inventoryCommandSchema>;
export type InventoryDraft = z.infer<typeof inventoryDraftSchema>;
export const inventoryItemSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  location: z.string(),
  defaultStartTime: z.string().nullable(),
  sourceTemplateId: z.string().nullable(),
  itemCount: z.number(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const inventoryResultSchema = z.object({
  requestId: idSchema,
  id: idSchema,
  outcome: z.enum([
    "applied",
    "superseded",
    "conflict",
    "cancelled",
    "removed",
  ]),
  item: inventoryItemSchema.nullable(),
});
export type InventoryResult = z.infer<typeof inventoryResultSchema>;
export function inventoryFingerprint(command: InventoryCommand) {
  const op = command.operation;
  return JSON.stringify(
    op.kind === "create"
      ? [
          op.kind,
          op.name,
          op.description,
          op.location,
          op.defaultStartTime,
          op.sourceTemplateId,
        ]
      : [
          op.kind,
          op.id,
          op.archived,
          new Date(op.expectedUpdatedAt).toISOString(),
        ],
  );
}
