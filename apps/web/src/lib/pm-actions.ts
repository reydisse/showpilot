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
      type: "incident-resolved",
      title: "Operational issue resolved",
      message: `${user.name || user.email} marked the issue as resolved.`,
      actionUrl: `production/incidents?incident=${encodeURIComponent(data.incidentId)}`,
      source: data.incidentId,
      pushTag: `incident-${data.incidentId}`,
    });

    return { ok: true };
  });

// ─── Copy crew from the previous service ─────────────────────

/**
 * Church rotas repeat. Copying last service's positions and resetting
 * everyone to unconfirmed is a far better starting point than an empty
 * board, and it makes the confirmation state meaningful rather than
 * inherited.
 */
export const copyCrewFromService = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        showId: idSchema,
        serviceDate: serviceDateSchema,
        copyFromShowId: idSchema,
        copyFrom: serviceDateSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "schedule:manage");

    const prisma = getPrisma() as unknown as {
      serviceAssignment?: {
        findMany(
          args: unknown,
        ): Promise<
          { role: string; department: string; crewMemberId: string | null; callTime: string }[]
        >;
        count(args: unknown): Promise<number>;
        createMany(args: unknown): Promise<unknown>;
      };
    };
    if (!prisma.serviceAssignment) {
      throw new Error(
        "Crew scheduling is not available — run pnpm db:generate",
      );
    }

    const already = await prisma.serviceAssignment.count({
      where: { orgId: data.orgId, showId: data.showId },
    });
    if (already > 0)
      throw new Error("This service already has a crew assigned");

    const source = await prisma.serviceAssignment.findMany({
      where: { orgId: data.orgId, showId: data.copyFromShowId },
      select: { role: true, department: true, crewMemberId: true, callTime: true },
    });
    if (source.length === 0)
      throw new Error("That service has no crew to copy");

    await prisma.serviceAssignment.createMany({
      data: source.map((row) => ({
        orgId: data.orgId,
        showId: data.showId,
        serviceDate: data.serviceDate,
        role: row.role,
        department: row.department,
        crewMemberId: row.crewMemberId,
        callTime: row.callTime,
        // Never inherit a confirmation. Last week's yes is not this
        // week's yes, and pretending otherwise is how a PM ends up
        // short on a Sunday morning.
        status: "assigned",
      })),
    });

    return { ok: true, copied: source.length };
  });

// ─── Set a duty officer ──────────────────────────────────────

/**
 * Name the production or technical manager for a week.
 *
 * Writes to `roster_assignment` — the org's existing weekly on-duty
 * roster (migration 0005), which the kiosk on-duty board and the
 * settings roster tab already read. There is deliberately no second
 * store: two screens disagreeing about who is running the service
 * would be worse than either.
 *
 * Unlike `saveRosterWeek`, which replaces a whole week, this touches
 * only the one slot so it cannot clobber the tech assignments made in
 * settings.
 */
export const setDutyOfficer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        weekStart: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
        duty: z.enum(["pm", "tm"]),
        /** Null clears the slot. */
        userId: idSchema.nullable(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");

    const { getD1 } = await import("@/lib/d1");
    const db = getD1();

    // The user must actually be a member of this org.
    if (data.userId) {
      const member = await getPrisma().member.findFirst({
        where: { organizationId: data.orgId, userId: data.userId },
        select: { id: true },
      });
      if (!member) throw new Error("Not found");
    }

    if (data.duty === "pm") {
      await db
        .prepare(
          "DELETE FROM roster_assignment WHERE orgId = ? AND weekStart = ? AND kind = 'pm'",
        )
        .bind(data.orgId, data.weekStart)
        .run();
      if (data.userId) {
        await db
          .prepare(
            "INSERT INTO roster_assignment (id, orgId, weekStart, kind, roleId, userId) VALUES (?, ?, ?, 'pm', NULL, ?)",
          )
          .bind(crypto.randomUUID(), data.orgId, data.weekStart, data.userId)
          .run();
      }
      return { ok: true };
    }

    // The technical manager is a tech row pointing at the "tm" roster role.
    const role = await db
      .prepare(
        "SELECT id FROM roster_role WHERE orgId = ? AND lower(code) = 'tm' LIMIT 1",
      )
      .bind(data.orgId)
      .first<{ id: string }>();
    if (!role) {
      throw new Error(
        'No "tm" roster role. Add the default roster roles in Settings first.',
      );
    }

    await db
      .prepare(
        "DELETE FROM roster_assignment WHERE orgId = ? AND weekStart = ? AND roleId = ?",
      )
      .bind(data.orgId, data.weekStart, role.id)
      .run();
    if (data.userId) {
      await db
        .prepare(
          "INSERT INTO roster_assignment (id, orgId, weekStart, kind, roleId, userId) VALUES (?, ?, ?, 'tech', ?, ?)",
        )
        .bind(
          crypto.randomUUID(),
          data.orgId,
          data.weekStart,
          role.id,
          data.userId,
        )
        .run();
    }
    return { ok: true };
  });
