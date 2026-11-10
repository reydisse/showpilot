import { z } from "zod";
import { idSchema } from "./validation";
export const kioskDisplaySnapshotSchema = z
  .object({ blanked: z.boolean(), revision: z.uuid().nullable() })
  .strict();
export type KioskDisplaySnapshot = z.infer<typeof kioskDisplaySnapshotSchema>;
export const kioskDisplayCommandSchema = z
  .object({
    orgId: idSchema,
    requestId: z.uuid(),
    blanked: z.boolean(),
    expectedRevision: z.uuid().nullable(),
  })
  .strict();
export type KioskDisplayCommand = z.infer<typeof kioskDisplayCommandSchema>;
export const kioskDisplayResultSchema = z
  .object({
    requestId: z.uuid(),
    outcome: z.enum(["applied", "conflict", "superseded"]),
    snapshot: kioskDisplaySnapshotSchema,
  })
  .strict();
export type KioskDisplayResult = z.infer<typeof kioskDisplayResultSchema>;

/** Legacy polling contract: only an explicit true blanks the display. */
export function interpretBlankedValue(
  value: string | null | undefined,
): boolean {
  return value === "true";
}
