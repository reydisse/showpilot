import { z } from "zod";
import { idSchema } from "./validation";

export const scheduleProviderSchema = z.enum([
  "native",
  "planning-center",
  "faithteams",
  "other",
]);
export type ScheduleProvider = z.infer<typeof scheduleProviderSchema>;
const externalUrl = z
  .string()
  .trim()
  .max(500)
  .url("Enter a scheduling workspace URL.")
  .refine(
    (value) => URL.canParse(value) && new URL(value).protocol === "https:",
    "Use an HTTPS scheduling workspace URL.",
  );
export const scheduleProviderConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("native"),
      url: z.literal(""),
      label: z.literal(""),
    })
    .strict(),
  z
    .object({
      provider: z.enum(["planning-center", "faithteams"]),
      url: externalUrl,
      label: z.literal(""),
    })
    .strict(),
  z
    .object({
      provider: z.literal("other"),
      url: externalUrl,
      label: z.string().trim().max(80),
    })
    .strict(),
]);
export type ScheduleProviderConfig = z.infer<
  typeof scheduleProviderConfigSchema
>;
const revision = z.string().min(1).max(64).nullable();
export const scheduleProviderCommandSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
    expectedRevision: revision,
    config: scheduleProviderConfigSchema,
  })
  .strict();
export type ScheduleProviderCommand = z.infer<
  typeof scheduleProviderCommandSchema
>;
export const scheduleProviderSnapshotSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    revision,
    config: scheduleProviderConfigSchema,
  })
  .strict();
export type ScheduleProviderSnapshot = z.infer<
  typeof scheduleProviderSnapshotSchema
>;
export const scheduleProviderResultSchema = z
  .object({
    requestId: z.uuid(),
    outcome: z.enum(["applied", "conflict", "superseded"]),
    snapshot: scheduleProviderSnapshotSchema,
  })
  .strict();

export type ScheduleProviderResult = z.infer<
  typeof scheduleProviderResultSchema
>;

export function scheduleProviderLabel(config: ScheduleProviderConfig) {
  return config.provider === "other"
    ? config.label || "External platform"
    : {
        native: "ShowPilot",
        "planning-center": "Planning Center",
        faithteams: "Faith Teams",
      }[config.provider];
}
