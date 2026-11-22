import { z } from "zod";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES } from "@showpilot/shared";
import { idSchema, labelSchema, textSchema } from "./validation";

export const equipmentFieldsSchema = z.object({
  name: labelSchema,
  category: z.enum(EQUIPMENT_CATEGORIES),
  status: z.enum(EQUIPMENT_STATUSES),
  location: z.string().max(200),
  serialNumber: z.string().max(200),
  notes: textSchema,
});
export const equipmentOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    fields: equipmentFieldsSchema,
    quantity: z.number().int().min(1).max(100),
  }),
  z.object({
    kind: z.literal("update"),
    id: idSchema,
    expectedRevision: z.number().int().min(0),
    updates: equipmentFieldsSchema
      .partial()
      .refine((value) => Object.keys(value).length > 0, "No changes to save"),
  }),
  z.object({
    kind: z.literal("delete"),
    id: idSchema,
    expectedRevision: z.number().int().min(0),
  }),
  // Several units at once (bulk status, an item's shared name/type, deleting an item).
  // Every unit must still be at its expected revision, or nothing changes.
  z.object({
    kind: z.literal("batch"),
    changes: z
      .array(
        z.union([
          z.object({
            id: idSchema,
            expectedRevision: z.number().int().min(0),
            updates: equipmentFieldsSchema
              .partial()
              .refine((value) => Object.keys(value).length > 0, "No changes to save"),
          }).strict(),
          z.object({
            id: idSchema,
            expectedRevision: z.number().int().min(0),
            remove: z.literal(true),
          }).strict(),
        ]),
      )
      .min(1)
      .max(100)
      .refine((changes) => new Set(changes.map((change) => change.id)).size === changes.length, "Each unit can change once per save"),
  }),
]);
export const equipmentCommandSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
  requestId: z.uuid(),
  expiresAt: z.number().int().positive(),
  operation: equipmentOperationSchema,
});
export const equipmentOutcomeSchema = z.object({
  requestId: z.uuid(),
  outcome: z.enum(["applied", "conflict", "cancelled", "expired"]),
  ids: z.array(idSchema),
});
export const equipmentItemSchema = z.object({
  id: idSchema,
  name: z.string(),
  category: z.string(),
  status: z.string(),
  location: z.string(),
  serialNumber: z.string(),
  notes: z.string(),
  revision: z.number().int().min(0),
});
export const equipmentStateSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
  serverTime: z.number(),
  equipment: z.array(equipmentItemSchema),
  canManage: z.boolean(),
});
export type EquipmentCommand = z.infer<typeof equipmentCommandSchema>;
export type EquipmentOperation = z.infer<typeof equipmentOperationSchema>;
export type EquipmentOutcome = z.infer<typeof equipmentOutcomeSchema>;
export type EquipmentState = z.infer<typeof equipmentStateSchema>;
