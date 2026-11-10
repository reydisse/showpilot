import { z } from "zod";
const identity = { orgId: z.string().min(1), requestId: z.uuid() };
const week = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const accessCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant"),
    ...identity,
    expectedWeekStart: week,
    userId: z.string().min(1),
    capability: z.string().min(1),
    duration: z.enum(["this-week", "until-revoked"]),
    reason: z.string().trim().max(240),
  }),
  z.object({
    kind: z.literal("revoke"),
    ...identity,
    expectedWeekStart: week,
    grantId: z.string().min(1),
  }),
  z.object({ kind: z.literal("notice"), ...identity }),
]);
export type AccessCommand = z.infer<typeof accessCommandSchema>;
export const accessReceiptSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  requestId: z.uuid(),
  kind: z.enum(["grant", "revoke"]),
  state: z.enum(["active", "revoked", "expired", "missing"]),
  notification: z.enum(["pending", "created", "superseded"]),
});
export type AccessReceipt = z.infer<typeof accessReceiptSchema>;
export const accessNoticeSchema = z.object({
  requestId: z.uuid(),
  kind: z.enum(["grant", "revoke"]),
  grantId: z.string(),
  title: z.string(),
  message: z.string(),
});

/** Keep the exact failed request in the signed-in account/org mutation cache. */
export function accessMutationOptions(input: {
  key: readonly unknown[];
  client: import("@tanstack/react-query").QueryClient;
  execute: (command: AccessCommand) => Promise<AccessReceipt>;
  confirmed: (result: AccessReceipt, command: AccessCommand) => void;
}) {
  return {
    mutationKey: input.key,
    gcTime: Infinity,
    networkMode: "always" as const,
    mutationFn: input.execute,
    onSuccess: input.confirmed,
    onSettled: () => {
      const cache = input.client.getMutationCache();
      for (const old of cache.findAll({
        mutationKey: input.key,
        exact: true,
      })) {
        if (old.state.status !== "pending") cache.remove(old);
      }
    },
  };
}
