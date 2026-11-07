import { NOTIFICATION_CATEGORIES } from "@showpilot/shared";
import type { MutationState, QueryClient } from "@tanstack/react-query";
import { z } from "zod";
export const preferenceCommandSchema = z.object({
  orgId: z.string().min(1),
  requestId: z.uuid(),
  category: z.enum(NOTIFICATION_CATEGORIES),
  deviceAlerts: z.boolean(),
  expectedDeviceAlerts: z.boolean(),
});
export type PreferenceCommand = z.infer<typeof preferenceCommandSchema>;
const preference = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  deviceAlerts: z.boolean(),
});
export const preferenceReceiptSchema = z.object({
  outcome: z.enum(["applied", "conflict", "superseded"]),
  preference,
  preferences: z.array(preference),
});
export type PreferenceReceipt = z.infer<typeof preferenceReceiptSchema>;
export function preferenceMutationSnapshot(
  state: Pick<MutationState, "status" | "variables" | "error" | "data">,
) {
  const command = preferenceCommandSchema.safeParse(state.variables);
  const receipt = preferenceReceiptSchema.safeParse(state.data);
  // Keep validation errors out of observable snapshots: each parse creates a
  // new error instance, which otherwise defeats structural sharing.
  return {
    status: state.status,
    error: state.error,
    command: command.success ? command.data : null,
    receipt: receipt.success ? receipt.data : null,
  };
}
export function preferenceMutationOptions(input: {
  key: readonly unknown[];
  client: QueryClient;
  execute: (command: PreferenceCommand) => Promise<PreferenceReceipt>;
  confirmed: (receipt: PreferenceReceipt) => void | Promise<void>;
}) {
  return {
    mutationKey: input.key,
    gcTime: Infinity,
    networkMode: "always" as const,
    mutationFn: input.execute,
    onSuccess: input.confirmed,
    onSettled: () => {
      const cache = input.client.getMutationCache();
      for (const old of cache.findAll({ mutationKey: input.key, exact: true }))
        if (old.state.status !== "pending") cache.remove(old);
    },
  };
}
