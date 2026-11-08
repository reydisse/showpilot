import { z } from "zod";
import {
  showManagementFieldsSchema,
  showSnapshotSchema,
  showDraftFromSnapshot,
} from "./show-management-recovery";
const id = z.string().min(1).max(64);
const scope = { orgId: id, userId: id, showId: id };
export const rundownDetailsFieldsSchema = showManagementFieldsSchema.extend({
  name: z.string().trim().max(120),
});
export const rundownDetailsReadSchema = z.object({
  ...scope,
  revision: z.number().int().nonnegative(),
  timeZone: rundownDetailsFieldsSchema.shape.timeZone,
  snapshot: showSnapshotSchema.nullable(),
});
export const rundownDetailsCommandSchema = rundownDetailsFieldsSchema
  .extend({
    ...scope,
    requestId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedUpdatedAt: showSnapshotSchema.shape.updatedAt,
  })
  .strict();
export const rundownDetailsReplySchema = z.object({
  ...scope,
  requestId: z.uuid(),
  outcome: z.enum([
    "applied",
    "superseded",
    "conflict",
    "cancelled",
    "removed",
  ]),
  snapshot: showSnapshotSchema.nullable(),
});
export type RundownDetailsScope = Pick<
  RundownDetailsRead,
  "orgId" | "userId" | "showId"
>;
export type RundownDetailsRead = z.infer<typeof rundownDetailsReadSchema>;
export type RundownDetailsCommand = z.infer<typeof rundownDetailsCommandSchema>;
export type RundownDetailsReply = z.infer<typeof rundownDetailsReplySchema>;
export type RundownDetailsDraft = {
  base: RundownDetailsRead & { snapshot: z.infer<typeof showSnapshotSchema> };
  fields: z.infer<typeof rundownDetailsFieldsSchema>;
};
export function rundownDetailsDraft(
  base: RundownDetailsRead,
): RundownDetailsDraft {
  if (!base.snapshot)
    throw new Error(
      "This show is no longer available. Your retained draft has not changed.",
    );
  return {
    base: { ...base, snapshot: base.snapshot },
    fields: showDraftFromSnapshot("edit", base.snapshot, base.timeZone).fields,
  };
}
