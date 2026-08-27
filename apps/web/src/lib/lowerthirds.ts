import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";

const lowerThirdTextSchema = z.string().max(500);

export const lowerThirdPayloadSchema = z.object({
  id: idSchema,
  type: z.enum(["person", "scripture", "freetext", "style"]),
  name: lowerThirdTextSchema.optional(),
  title: lowerThirdTextSchema.optional(),
  scripture: lowerThirdTextSchema.optional(),
  translation: z.string().max(40).optional(),
  line1: lowerThirdTextSchema.optional(),
  line2: lowerThirdTextSchema.optional(),
  style: z.string().max(100),
  triggeredBy: z.string().max(200).optional(),
});

// ─── Types ────────────────────────────────────────────────────

export type LowerThirdType = "person" | "scripture" | "freetext" | "style";

export type LowerThirdState = "idle" | "live" | "clearing";

export interface LowerThirdPayload {
  id: string;
  type: LowerThirdType;
  name?: string;
  title?: string;
  scripture?: string;
  translation?: string;
  line1?: string;
  line2?: string;
  style: string; // "default" | "minimal" | "scripture"
  state: LowerThirdState;
  triggeredBy?: string;
  triggeredAt?: string;
}

/**
 * Persist the active lower third for an org and return the stored payload.
 * Caller is responsible for access control and the cloud-enabled gate.
 * Browser control uses graphics.ts; Companion uses its signed-token API.
 */
export async function triggerLowerThirdForOrg(
  orgId: string,
  payload: z.infer<typeof lowerThirdPayloadSchema>,
  triggeredBy?: string,
): Promise<LowerThirdPayload> {
  const prisma = getPrisma();
  const fullPayload: LowerThirdPayload = {
    ...payload,
    state: "live",
    triggeredBy: triggeredBy ?? "unknown",
    triggeredAt: new Date().toISOString(),
  };

  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: "active-lower-third" } },
    create: { orgId, key: "active-lower-third", value: JSON.stringify(fullPayload) },
    update: { value: JSON.stringify(fullPayload) },
  });

  return fullPayload;
}

/** Clear the active lower third for an org. */
export async function clearLowerThirdForOrg(orgId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.appSetting.deleteMany({ where: { orgId, key: "active-lower-third" } });
}

/** Read the active lower third for an org (null when none). */
export async function readLowerThirdForOrg(orgId: string): Promise<LowerThirdPayload | null> {
  const prisma = getPrisma();
  const setting = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: "active-lower-third" } },
  });
  if (!setting) return null;
  try {
    return JSON.parse(setting.value) as LowerThirdPayload;
  } catch {
    return null;
  }
}

export const resetLowerThirdLibrary = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "lowerthird:configure");
    const prisma = getPrisma();
    await prisma.graphicTemplate.deleteMany({ where: { orgId: data.orgId } });
  });
