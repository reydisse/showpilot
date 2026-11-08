import { z } from "zod";
const id = z.string().min(1).max(64);
const identity = { orgId: id, userId: id, requestId: z.uuid() };
export const crewFieldsSchema = z.object({
  memberId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.union([z.literal(""), z.email().max(254)])),
  photoUrl: z.string().max(2_100_000),
});
export const crewCommandSchema = z.discriminatedUnion("kind", [
  crewFieldsSchema.extend({ kind: z.literal("create"), ...identity }).strict(),
  crewFieldsSchema
    .extend({
      kind: z.literal("update"),
      ...identity,
      id,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      ...identity,
      id,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type CrewCommand = z.infer<typeof crewCommandSchema>;
export const crewReceiptSchema = z
  .object({
    ...identity,
    kind: z.enum(["create", "update", "delete"]),
    outcome: z.enum(["applied", "cancelled"]),
    id: id.nullable(),
  })
  .refine(
    (value) =>
      value.id !== null ||
      (value.kind === "create" && value.outcome === "cancelled"),
  );
export type CrewReceipt = z.infer<typeof crewReceiptSchema>;
export const crewSnapshotSchema = z.object({
  id,
  memberId: z.string(),
  name: z.string(),
  role: z.string(),
  email: z.string(),
  photoUrl: z.string(),
  profileRevision: z.number().int().nonnegative(),
});
export const crewReadSchema = z.object({
  orgId: id,
  userId: id,
  id,
  snapshot: crewSnapshotSchema.nullable(),
});
export type CrewRead = z.infer<typeof crewReadSchema>;
export type CrewSnapshot = z.infer<typeof crewSnapshotSchema>;
export type CrewDraft = {
  slot: string;
  fields: z.infer<typeof crewFieldsSchema>;
} & (
  | { kind: "create"; base: null }
  | { kind: "update" | "delete"; base: CrewSnapshot }
);
export function newCrewDraft(): CrewDraft {
  return {
    slot: "new",
    kind: "create",
    base: null,
    fields: { memberId: "", name: "", role: "", email: "", photoUrl: "" },
  };
}
export function crewDraftFromSnapshot(
  kind: "update" | "delete",
  base: CrewSnapshot,
): CrewDraft {
  const { memberId, name, role, email, photoUrl } = base;
  return {
    slot: base.id,
    kind,
    base,
    fields: { memberId, name, role, email, photoUrl },
  };
}
export const crewRoles = [
  "Production Director",
  "Production Manager",
  "Stage Manager",
  "Technical Director",
  "Audio Engineer",
  "Broadcast Mixer",
  "FOH Engineer",
  "Monitor Engineer",
  "Camera Director",
  "Camera Operator",
  "Graphics Operator",
  "Lighting Director",
  "Lighting Operator",
  "Streaming Director",
  "Stream Operator",
  "ProPresenter Operator",
];

export async function prepareCrewPhoto(
  work: () => Promise<string>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Photo preparation timed out. Choose a smaller photo and retry.",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
