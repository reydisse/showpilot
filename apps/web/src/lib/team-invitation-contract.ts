import { z } from "zod";
import { emailSchema, idSchema } from "./validation";
export const invitationDeliverySchema = z.object({
  id: z.string().nullable(),
  state: z.enum([
    "unknown",
    "ready",
    "sending",
    "accepted",
    "failed",
    "uncertain",
  ]),
  retryable: z.boolean(),
  updatedAt: z.number().nullable(),
});
export const teamInvitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  status: z.enum(["pending", "accepted", "rejected", "canceled"]),
  inviterId: z.string(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  delivery: invitationDeliverySchema,
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;

export const teamInvitationInputSchema = z.object({
  orgId: idSchema,
  email: emailSchema,
  role: z.string().min(1).max(50),
  requestId: z.uuid().optional(),
  resend: z
    .object({ invitationId: idSchema, previousDeliveryId: z.uuid().nullable() })
    .optional(),
});
export const retryInvitationDeliverySchema = z.object({
  orgId: idSchema,
  invitationId: idSchema,
  deliveryId: z.uuid(),
});
export type TeamInvitationInput = z.infer<typeof teamInvitationInputSchema>;
export function invitationRequestHeaders(
  input: Pick<TeamInvitationInput, "requestId" | "resend">,
  original?: HeadersInit,
) {
  const headers = new Headers(original);
  if (input.requestId) headers.set("Idempotency-Key", input.requestId);
  if (input.resend) {
    headers.set("X-ShowPilot-Invitation", input.resend.invitationId);
    headers.set(
      "X-ShowPilot-Previous-Delivery",
      input.resend.previousDeliveryId ?? "none",
    );
  }
  return headers;
}
