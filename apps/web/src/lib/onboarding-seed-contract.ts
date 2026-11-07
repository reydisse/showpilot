import { z } from "zod";
import { getOnboardingTemplate, type OnboardingTemplateId } from "./templates";
import { idSchema, serviceDateSchema } from "./validation";

export const onboardingTemplateIdSchema = z.custom<OnboardingTemplateId>(
  value => typeof value === "string" && getOnboardingTemplate(value) !== null,
  "Unknown template",
);
export const onboardingSeedInputSchema = z.object({ orgId: idSchema, template: onboardingTemplateIdSchema, serviceDate: serviceDateSchema });
export type OnboardingSeedInput = z.infer<typeof onboardingSeedInputSchema>;
export const onboardingSeedMarkerSchema = z.object({ template: onboardingTemplateIdSchema, serviceDate: serviceDateSchema });
export const onboardingSeedSnapshotSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("review"), message: z.string().min(1) }),
  z.object({ status: z.literal("saved"), template: onboardingTemplateIdSchema, serviceDate: serviceDateSchema,
    showId: z.string().min(1).nullable(), items: z.array(z.object({ id: z.string().min(1), title: z.string(), duration: z.number().finite().nonnegative() })) }),
]);
export type OnboardingSeedSnapshot = z.infer<typeof onboardingSeedSnapshotSchema>;
export const ONBOARDING_SEED_KEY = "onboarding-template-seeded";
