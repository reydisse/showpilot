import { z } from "zod";
import { idSchema } from "./validation";
const revision = z.number().int().nonnegative();
export const graphicsClearCommandSchema = z
  .object({
    orgId: idSchema,
    requestId: z.string().uuid(),
    expectedProgramRevision: revision,
    expectedRelayRevision: revision,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GraphicsClearCommand = z.infer<typeof graphicsClearCommandSchema>;
export const graphicsClearOutcomeSchema = z.enum([
  "applied",
  "conflict",
  "expired",
]);
export const graphicsClearResultSchema = z.object({
  requestId: z.string().uuid(),
  program: graphicsClearOutcomeSchema,
  relay: z.enum(["applied", "conflict", "expired", "skipped"]),
});
export const graphicsClearSnapshotSchema = z.object({
  programRevision: revision,
  relayRevision: revision,
  serverTime: z.number(),
  program: z.array(z.object({ id: z.string(), title: z.string() })),
  programUnknown: z.boolean(),
  lowerThirds: z.array(z.string()),
  canClear: z.boolean(),
});
export type GraphicsClearSnapshot = z.infer<typeof graphicsClearSnapshotSchema>;
export const reviewedRelayClearSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: revision,
    expiresAt: z.number().int().positive(),
  })
  .strict();
