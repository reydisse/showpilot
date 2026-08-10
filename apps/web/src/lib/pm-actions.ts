/**
 * Production dashboard mutations.
 *
 * Kept out of `pm-dashboard.ts` so the read path stays a pure aggregate.
 * Every handler asserts permission on its first line and scopes by
 * orgId; functions that receive only a row id resolve that row's orgId
 * before asserting, per the multi-tenancy rules in CLAUDE.md.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getRundownStateForOrg, persistRundownItemsForOrg } from "@/lib/rundown";
import type { RundownItem } from "@/types/rundown";

async function getSessionUser() {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  return session.user;
}

async function assertOrgPermission(orgId: string, permission: Permission) {
  const user = await getSessionUser();
  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: user.id },
    select: { role: true },
  });
  if (!member) throw new Error("Forbidden");
  if (!hasAnyPermission(member.role ?? "member", [permission])) throw new Error("Forbidden");
  return { user, role: member.role ?? "member" };
}

// ─── Create the next service ─────────────────────────────────

/**
 * The actual planning-day job: make Sunday exist. Clones the previous
 * service's rundown so the PM starts from last week rather than a blank
 * page, and sets the scheduled start so the dashboard has something to
 * count toward.
 */
export const createNextService = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        /** Service to clone the rundown from. Omit for an empty one. */
        copyFrom: serviceDateSchema.optional(),
        /** Local wall-clock start, "HH:MM". */
        startTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Start time must be HH:MM")
          .optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "rundown:edit");

    const existing = await getRundownStateForOrg({
      orgId: data.orgId,
      serviceDate: data.serviceDate,
    });
    if (existing.items.length > 0) {
      throw new Error("That service already has a rundown");
    }

    if (data.copyFrom) {
      const source = await getRundownStateForOrg({
        orgId: data.orgId,
        serviceDate: data.copyFrom,
      });
      // Carry the shape of the service, not last week's execution:
      // durations and owners yes, actual timings and live status no.
      const cloned: RundownItem[] = source.items.map((item, index) => ({
        ...item,
        id: `${data.serviceDate}-${index}`,
        status: "upcoming",
        scheduledStart: null,
        expectedEnd: null,
        actualStart: null,
        actualEnd: null,
      }));
      if (cloned.length > 0) {
        await persistRundownItemsForOrg(data.orgId, data.serviceDate, cloned);
      }
    }

    if (data.startTime) {
      const scheduled = new Date(`${data.serviceDate}T${data.startTime}:00`);
      const prisma = getPrisma() as unknown as {
        rundown?: {
          upsert(args: unknown): Promise<unknown>;
        };
      };
      if (prisma.rundown) {
        await prisma.rundown.upsert({
          where: { orgId_serviceDate: { orgId: data.orgId, serviceDate: data.serviceDate } },
          update: { scheduledStartTime: scheduled },
          create: {
            orgId: data.orgId,
            serviceDate: data.serviceDate,
            scheduledStartTime: scheduled,
            status: "stopped",
          },
        });
      }
    }

    return { ok: true, serviceDate: data.serviceDate };
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

    const { user } = await assertOrgPermission(incident.orgId, "incidents:access");

    await prisma.incident.update({
      where: { id: data.incidentId },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: user.name || user.email || user.id,
      } as never,
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
        serviceDate: serviceDateSchema,
        copyFrom: serviceDateSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");

    const prisma = getPrisma() as unknown as {
      serviceAssignment?: {
        findMany(args: unknown): Promise<{ role: string; crewMemberId: string | null }[]>;
        count(args: unknown): Promise<number>;
        createMany(args: unknown): Promise<unknown>;
      };
    };
    if (!prisma.serviceAssignment) {
      throw new Error("Crew scheduling is not available — run pnpm db:generate");
    }

    const already = await prisma.serviceAssignment.count({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
    });
    if (already > 0) throw new Error("This service already has a crew assigned");

    const source = await prisma.serviceAssignment.findMany({
      where: { orgId: data.orgId, serviceDate: data.copyFrom },
      select: { role: true, crewMemberId: true },
    });
    if (source.length === 0) throw new Error("That service has no crew to copy");

    await prisma.serviceAssignment.createMany({
      data: source.map((row) => ({
        orgId: data.orgId,
        serviceDate: data.serviceDate,
        role: row.role,
        crewMemberId: row.crewMemberId,
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
 * Minimal inline scheduling: name the production or technical manager
 * for one service.
 *
 * ShowPilot has no scheduling product yet, and the intended destination
 * is a Planning Center Services adapter writing into ServiceAssignment
 * as the native fallback (see the OnTime and ProPresenter pattern).
 * This is deliberately not a rota editor — it exists so the two roles
 * the dashboard reports on can actually be set today, and it writes the
 * same rows the adapter eventually will.
 */
export const setDutyOfficer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        duty: z.enum(["pm", "tm"]),
        /** Null clears the slot. */
        crewMemberId: idSchema.nullable(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");

    const prisma = getPrisma() as unknown as {
      serviceAssignment?: {
        findMany(args: unknown): Promise<{ id: string; role: string }[]>;
        update(args: unknown): Promise<unknown>;
        create(args: unknown): Promise<unknown>;
        delete(args: unknown): Promise<unknown>;
      };
    };
    if (!prisma.serviceAssignment) {
      throw new Error("Crew scheduling is not available — run pnpm db:generate");
    }

    // The crew member must belong to this org; never trust the id alone.
    if (data.crewMemberId) {
      const member = await getPrisma().crewMember.findFirst({
        where: { id: data.crewMemberId, orgId: data.orgId },
        select: { id: true },
      });
      if (!member) throw new Error("Not found");
    }

    const { dutyKeyFor } = await import("@/lib/pm-dashboard-derive");
    const existing = await prisma.serviceAssignment.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
      select: { id: true, role: true },
    });
    const current = existing.find((row) => dutyKeyFor(row.role) === data.duty);

    if (!data.crewMemberId) {
      if (current) await prisma.serviceAssignment.delete({ where: { id: current.id } });
      return { ok: true };
    }

    const role = data.duty === "pm" ? "Production Manager" : "Technical Manager";
    if (current) {
      await prisma.serviceAssignment.update({
        where: { id: current.id },
        // A newly named person has not confirmed yet, whoever they are.
        data: { crewMemberId: data.crewMemberId, status: "assigned", respondedAt: null },
      });
    } else {
      await prisma.serviceAssignment.create({
        data: {
          orgId: data.orgId,
          serviceDate: data.serviceDate,
          role,
          crewMemberId: data.crewMemberId,
          status: "assigned",
        },
      });
    }

    return { ok: true };
  });
