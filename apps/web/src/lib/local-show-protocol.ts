import { z } from "zod";

const localId = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/);
export const localShowPreparationInput = z.object({
  orgId: localId,
  showId: localId,
  installationId: localId,
  sessionId: z.uuid(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedRevision: z.number().int().nonnegative(),
});
export type LocalShowPreparationInput = z.infer<
  typeof localShowPreparationInput
>;
