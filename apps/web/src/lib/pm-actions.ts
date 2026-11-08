/**
 * Production dashboard mutations.
 *
 * Kept out of `pm-dashboard.ts` so the read path stays a pure aggregate.
 * Every handler asserts permission on its first line and scopes by
 * orgId; functions that receive only a row id resolve that row's orgId
 * before asserting, per the multi-tenancy rules in CLAUDE.md.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import type { Permission } from "@/lib/app-permissions";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

async function assertOrgPermission(orgId: string, permission: Permission) {
  const { user, access } = await assertEffectiveOrgPermission(orgId, permission);
  return { user, role: access.role };
}

// ─── Create the next service ─────────────────────────────────

const createServiceInputSchema = z.object({
  timeZone: z.string().min(1).max(100).optional(),
  orgId: idSchema,
  serviceDate: serviceDateSchema,
  /** Service to clone the rundown from. Omit for an empty one. */
  copyFrom: serviceDateSchema.optional(),
  copyFromShowId: idSchema.optional(),
  /** Optional label, e.g. "Christmas Eve 7pm". */
  name: z.string().max(120).optional(),
  /** Local wall-clock start, "HH:MM". */
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Start time must be HH:MM")
    .optional(),
  /** Optional show-specific venue call, "HH:MM". */
  callTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Call time must be HH:MM")
    .optional(),
  location: z.string().trim().max(240).optional(),
  inventoryId: idSchema.optional(),
});

/**
 * The actual planning-day job: make Sunday exist. Clones the previous
 * service's rundown so the PM starts from last week rather than a blank
 * page, and sets the scheduled start so the dashboard has something to
 * count toward.
 */
export const createNextService = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(createServiceInputSchema, data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "schedule:manage");
    const { createServiceForOrg } = await import("@/lib/service-creation.server");
    return createServiceForOrg(data);
  });

// ─── Resolve an incident ─────────────────────────────────────

/**
 * Closing the loop. Until 0012 an incident could only ever be logged,
 * never cleared, which is why nothing carried forward.
 */
export const resolveIncident = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ incidentId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    // Only a row id was supplied, so resolve its org before asserting.
    const incident = await prisma.incident.findUnique({
      where: { id: data.incidentId },
      select: { orgId: true },
    });
    if (!incident) throw new Error("Not found");

    const { user } = await assertOrgPermission(
      incident.orgId,
      "incidents:access",
    );

    await prisma.incident.update({
      where: { id: data.incidentId },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: user.name || user.email || user.id,
      } as never,
    });

    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: incident.orgId,
      actorId: user.id,
      includeLeadership: true,
      category: "incidents",
      type: "incident-resolved",
      title: "Operational issue resolved",
      message: `${user.name || user.email} marked the issue as resolved.`,
      actionUrl: `production/incidents?incident=${encodeURIComponent(data.incidentId)}`,
      source: data.incidentId,
      pushTag: `incident-${data.incidentId}`,
    });

    return { ok: true };
  });
