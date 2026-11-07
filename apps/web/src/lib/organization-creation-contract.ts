import { z } from "zod";
import { idSchema, orgSlugSchema } from "./validation";

export const creationRequestIdSchema = z.uuid();
export const createdOrganizationSchema = z.object({ id: idSchema, name: z.string().min(1), slug: orgSlugSchema });
export const organizationCreationAckSchema = createdOrganizationSchema.extend({ creationRequestId: creationRequestIdSchema });
export const organizationCreationSnapshotSchema = z.discriminatedUnion("status", [
  z.object({ requestId: creationRequestIdSchema, status: z.literal("empty") }),
  z.object({ requestId: creationRequestIdSchema, status: z.literal("saved"), organization: createdOrganizationSchema }),
  z.object({ requestId: creationRequestIdSchema, status: z.literal("removed") }),
  z.object({ requestId: creationRequestIdSchema, status: z.literal("forbidden") }),
]);
export type OrganizationCreationSnapshot = z.infer<typeof organizationCreationSnapshotSchema>;
export type CreatedOrganization = z.infer<typeof createdOrganizationSchema>;
