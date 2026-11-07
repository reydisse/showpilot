import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";
const revision = z.number().int().nonnegative();
export const dutyRoleSchema = z.object({
  id: idSchema,
  code: z.string(),
  name: z.string(),
  short: z.string(),
  sortOrder: z.number().int(),
  revision,
});
export type DutyRole = z.infer<typeof dutyRoleSchema>;
export const dutyRosterSnapshotSchema = z.object({
  rolesRevision: revision,
  weekRevision: revision,
  roles: z.array(dutyRoleSchema),
  tech: z.record(z.string(), z.string()),
  pmUserId: idSchema.nullable(),
  members: z.array(z.object({ id: idSchema, name: z.string() })),
  pendingNotifications: z.number().int().nonnegative(),
});
export type DutyRosterSnapshot = z.infer<typeof dutyRosterSnapshotSchema>;
const base = {
  orgId: idSchema,
  weekStart: serviceDateSchema,
  requestId: z.uuid(),
  rolesRevision: revision,
};
export const dutyRosterCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("seed-roles") }).strict(),
  z
    .object({
      ...base,
      action: z.literal("create-role"),
      code: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .transform((v) => v.toLowerCase().replace(/\s+/g, "-")),
      name: z.string().trim().min(1).max(200),
      short: z.string().trim().min(1).max(10),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("delete-role"),
      roleId: idSchema,
      roleRevision: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("save-week"),
      weekRevision: revision,
      tech: z
        .array(z.object({ roleId: idSchema, userId: idSchema }).strict())
        .max(100)
        .refine(
          (v) => new Set(v.map((s) => s.roleId)).size === v.length,
          "A duty role can only be assigned once",
        ),
      pmUserId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("set-officer"),
      weekRevision: revision,
      duty: z.enum(["pm", "tm"]),
      userId: idSchema.nullable(),
    })
    .strict(),
]);
export type DutyRosterCommand = z.infer<typeof dutyRosterCommandSchema>;
export const dutyRosterResultSchema = z
  .object({
    requestId: z.uuid(),
    outcome: z.enum([
      "applied",
      "conflict",
      "role-code-taken",
      "member-unavailable",
    ]),
    snapshot: dutyRosterSnapshotSchema,
  })
  .strict();
export type DutyRosterResult = z.infer<typeof dutyRosterResultSchema>;
export const DEFAULT_DUTY_ROLES = [
  { code: "tm", name: "Technical Manager", short: "TM" },
  { code: "audio", name: "Audio / FOH", short: "Audio" },
  { code: "cam1", name: "Camera 1", short: "Cam 1" },
  { code: "cam2", name: "Camera 2", short: "Cam 2" },
  { code: "pro", name: "ProPresenter", short: "Pro" },
  { code: "stream", name: "Stream", short: "Stream" },
] as const;
