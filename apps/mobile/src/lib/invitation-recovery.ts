import { z } from "zod";

export const invitationDeliverySchema = z.object({
  id: z.string().nullable(), state: z.enum(["unknown", "ready", "sending", "accepted", "failed", "uncertain"]),
  retryable: z.boolean(), updatedAt: z.number().nullable(),
});
export const invitationCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invite"), orgId: z.string(), email: z.email(), role: z.string(), requestId: z.uuid(),
    resend: z.object({ invitationId: z.string(), previousDeliveryId: z.string().nullable() }).optional() }),
  z.object({ kind: z.literal("retry"), orgId: z.string(), invitationId: z.string(), deliveryId: z.string() }),
]);
export type InvitationCommand = z.infer<typeof invitationCommandSchema>;
export function invitationDeliveryText(delivery: z.infer<typeof invitationDeliverySchema>): string {
  switch (delivery.state) {
    case "accepted": return "Email provider accepted the invitation. Waiting for the recipient to join.";
    case "failed": return "The invitation exists, but its email was rejected.";
    case "sending": return "Waiting for email confirmation. Refresh status before sending again.";
    case "ready": return "The invitation exists. Its email has not been confirmed.";
    case "uncertain": return delivery.retryable ? "Email acceptance is unknown. Retry the same email attempt." : "Email acceptance is unknown. Its safe retry window has ended.";
    case "unknown": return "No email delivery record is available. Share the invitation link or send again.";
  }
}

export function invitationStatusText(invitation: { status: string; expiresAt: string; delivery: z.infer<typeof invitationDeliverySchema> }): string {
  if (invitation.status !== "pending") return `Invitation ${invitation.status}. No email will be retried.`;
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) return "This invitation has expired. Send again to renew it before sharing the link.";
  return invitationDeliveryText(invitation.delivery);
}

// The mutation cache belongs to the signed-in app session, so leaving a screen
// does not discard the exact failed request. Completed older entries are pruned.
export function invitationMutationOptions<T>(input: {
  key: readonly unknown[];
  client: import("@tanstack/react-query").QueryClient;
  execute: (command: InvitationCommand) => Promise<T>;
  confirmed: (result: T) => void;
}) {
  return {
    mutationKey: input.key,
    gcTime: Infinity,
    networkMode: "always" as const,
    mutationFn: input.execute,
    onSuccess: input.confirmed,
    onSettled: () => {
      const cache = input.client.getMutationCache();
      for (const old of cache.findAll({ mutationKey: input.key, exact: true })) {
        if (old.state.status !== "pending") cache.remove(old);
      }
    },
  };
}
