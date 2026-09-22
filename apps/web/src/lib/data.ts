import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES } from "@showpilot/shared";
import type { Permission } from "@/lib/app-permissions";
import {
  createChecklistTemplateId,
  deleteChecklistEntryCore,
  findChecklistTemplateId,
  type ChecklistTemplateWrite,
} from "@/lib/checklist-core";
import { persistChecklistItem } from "@/lib/checklist-write.server";
import {
  setChecklistEntryCategory,
  transitionChecklistEntry,
} from "@/lib/checklist-toggle.server";
import { getPrisma } from "@/lib/db";
import { DEPARTMENT_ORDER } from "@/lib/departments";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { getRundownStateForOrg } from "@/lib/rundown";
import {
  deriveChecklistSuggestions,
  normalizeChecklistLabel,
} from "@/lib/smart-checklist-rules";
import {
  idSchema,
  labelSchema,
  parseOrThrow,
  serviceDateSchema,
} from "@/lib/validation";
import { applyPublicAttendanceIntent } from "@/lib/public-checkin";
import { enforcePublicCheckInRateLimit } from "@/lib/public-checkin-rate-limit.server";

const nameSchema = z.string().min(1).max(200);
const longTextSchema = z.string().max(10_000);
// Photos arrive as data URLs; the public flow re-checks decoded byte size.
const photoUrlSchema = z.string().max(2_100_000);
const optionalCrewEmailSchema = z.union([
  z.literal(""),
  z.email("Enter a valid email address").max(254),
]);

async function assertOrgPermission(
  orgId: string,
  permission: Permission | Permission[],
) {
  await assertEffectiveOrgPermission(orgId, permission);
}

// ─── Crew Members ───────────────────────────────────────────

export const getCrewMembers = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "show:view");
    const prisma = getPrisma();
    return await prisma.crewMember.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

export const addCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        memberId: idSchema,
        name: nameSchema,
        role: z.string().max(100),
        email: optionalCrewEmailSchema.optional(),
        photoUrl: photoUrlSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    return await prisma.crewMember.create({
      data: {
        orgId: data.orgId,
        memberId: data.memberId,
        name: data.name,
        role: data.role,
        email: data.email?.trim().toLowerCase() ?? "",
        photoUrl: data.photoUrl ?? "",
      },
    });
  });

export const updateCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z
          .object({
            memberId: idSchema,
            name: nameSchema,
            role: z.string().max(100),
            email: optionalCrewEmailSchema,
            photoUrl: photoUrlSchema,
            isOnline: z.boolean(),
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    const existing = await prisma.crewMember.findFirst({
      where: { id: data.id, orgId: data.orgId },
      select: { id: true },
    });
    if (!existing) throw new Error("Crew member not found");
    return await prisma.crewMember.update({
      where: { id: data.id },
      data: {
        ...data.updates,
        ...(data.updates.email !== undefined
          ? { email: data.updates.email.trim().toLowerCase() }
          : {}),
      },
    });
  });

export const deleteCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    const result = await prisma.crewMember.deleteMany({
      where: { id: data.id, orgId: data.orgId },
    });
    if (result.count === 0) throw new Error("Crew member not found");
  });

export const toggleCheckIn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, id: idSchema, isOnline: z.boolean() }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checkin:access");
    const prisma = getPrisma();
    const now = new Date();
    const existing = await prisma.crewMember.findFirst({
      where: { id: data.id, orgId: data.orgId },
      select: { id: true },
    });
    if (!existing) throw new Error("Crew member not found");
    return await prisma.crewMember.update({
      where: { id: data.id },
      data: {
        isOnline: !data.isOnline,
        ...(data.isOnline ? { lastCheckOut: now } : { lastCheckIn: now }),
      },
    });
  });

export const setAllCrewCheckIn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, isOnline: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checkin:access");
    const now = new Date();
    return getPrisma().crewMember.updateMany({
      where: { orgId: data.orgId, isOnline: !data.isOnline },
      data: {
        isOnline: data.isOnline,
        ...(data.isOnline ? { lastCheckIn: now } : { lastCheckOut: now }),
      },
    });
  });

export const checkInByMemberId = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, memberId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checkin:access");
    const prisma = getPrisma();
    const member = await prisma.crewMember.findUnique({
      where: { orgId_memberId: { orgId: data.orgId, memberId: data.memberId } },
    });
    if (!member) return null;
    const now = new Date();
    const updated = await prisma.crewMember.update({
      where: { id: member.id },
      data: {
        isOnline: !member.isOnline,
        ...(member.isOnline ? { lastCheckOut: now } : { lastCheckIn: now }),
      },
    });
    return {
      name: updated.name,
      photoUrl: updated.photoUrl,
      role: updated.role,
      isOnline: updated.isOnline,
    };
  });

export const getPublicCheckInOrg = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.organization.findUnique({
      where: { slug: data.slug },
      select: { id: true, name: true, slug: true },
    });
  });

export const publicCheckInByMemberId = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        slug: z.string().min(1).max(64),
        memberId: idSchema,
        intent: z.enum(["check-in", "check-out"]),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await enforcePublicCheckInRateLimit("write", data.slug, data.memberId);
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.slug },
      select: { id: true },
    });
    if (!org) return null;

    const updated = await applyPublicAttendanceIntent(prisma, {
      orgId: org.id,
      memberId: data.memberId,
      intent: data.intent,
    });
    if (!updated) return null;

    return {
      name: updated.name,
      memberId: updated.memberId,
      photoUrl: updated.photoUrl,
      role: updated.role,
      isOnline: updated.isOnline,
    };
  });

export const getPublicCrewMemberByMemberId = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string; memberId: string }) => data)
  .handler(async ({ data }) => {
    await enforcePublicCheckInRateLimit("read", data.slug, data.memberId);
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.slug },
      select: { id: true },
    });
    if (!org) return null;

    const member = await prisma.crewMember.findUnique({
      where: { orgId_memberId: { orgId: org.id, memberId: data.memberId } },
      select: {
        memberId: true,
        name: true,
        photoUrl: true,
        role: true,
        isOnline: true,
      },
    });

    return member;
  });

// ─── Checklist ──────────────────────────────────────────────

export const addChecklistItem = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        label: labelSchema,
        category: z.enum(DEPARTMENT_ORDER),
        serviceDate: serviceDateSchema,
        showId: idSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    const [show, templates] = await Promise.all([
      prisma.rundown.findFirst({
        where: {
          id: data.showId,
          orgId: data.orgId,
          serviceDate: data.serviceDate,
        },
        select: { id: true },
      }),
      prisma.checklistTemplate.findMany({
        where: { orgId: data.orgId },
        select: { id: true, label: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    if (!show) throw new Error("Show not found");

    const label = data.label.trim();
    const existingTemplateId = findChecklistTemplateId(templates, label);
    const template: ChecklistTemplateWrite = existingTemplateId
      ? { kind: "existing", id: existingTemplateId, category: data.category }
      : {
          kind: "new",
          id: await createChecklistTemplateId(data.orgId, label),
          label,
          category: data.category,
        };
    return persistChecklistItem({
      orgId: data.orgId,
      showId: data.showId,
      serviceDate: data.serviceDate,
      template,
    });
  });

export const updateChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z.object({ category: z.enum(DEPARTMENT_ORDER) }),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    return setChecklistEntryCategory({
      orgId: data.orgId,
      entryId: data.id,
      category: data.updates.category,
    });
  });

export const deleteChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    return deleteChecklistEntryCore({
      entry: { id: data.id, orgId: data.orgId },
      store: {
        deleteMany: (where) => prisma.checklistEntry.deleteMany({ where }),
      },
    });
  });

export const getChecklistEntries = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        showId: idSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, [
      "checklist:view",
      "checklist:access",
    ]);
    const prisma = getPrisma();
    const entries = await prisma.checklistEntry.findMany({
      where: {
        orgId: data.orgId,
        ...(data.showId
          ? { showId: data.showId }
          : { serviceDate: data.serviceDate }),
      },
      include: { template: true },
    });
    return entries.map((entry) => ({
      ...entry,
      template: { ...entry.template, category: entry.category },
    }));
  });

export const toggleChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        checked: z.boolean(),
        expectedRevision: z.number().int().min(0),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    if (!session) throw new Error("Unauthorized");
    return transitionChecklistEntry({
      orgId: data.orgId,
      entryId: data.id,
      checked: data.checked,
      expectedRevision: data.expectedRevision,
      actorName: session.user.name,
    });
  });

export type SmartChecklistDraft = ReturnType<
  typeof deriveChecklistSuggestions
>[number] & {
  existingTemplateId: string | null;
};

async function buildSmartChecklistDraft(
  orgId: string,
  serviceDate: string,
  showId?: string,
): Promise<SmartChecklistDraft[]> {
  const prisma = getPrisma();
  const [rundown, templates, entries] = await Promise.all([
    getRundownStateForOrg({ orgId, serviceDate, showId }),
    prisma.checklistTemplate.findMany({
      where: { orgId },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.checklistEntry.findMany({
      where: { orgId, ...(showId ? { showId } : { serviceDate }) },
      select: { templateId: true },
    }),
  ]);
  const entryTemplateIds = new Set(entries.map((entry) => entry.templateId));
  const templatesByLabel = new Map(
    templates.map((template) => [
      normalizeChecklistLabel(template.label),
      template,
    ]),
  );

  return deriveChecklistSuggestions(rundown.items).flatMap((suggestion) => {
    const existing = templatesByLabel.get(
      normalizeChecklistLabel(suggestion.label),
    );
    if (existing && entryTemplateIds.has(existing.id)) return [];
    return [{ ...suggestion, existingTemplateId: existing?.id ?? null }];
  });
}

/** Generate a reviewable draft. This is read-only and never publishes checks. */
export const getSmartChecklistDraft = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        showId: idSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    return buildSmartChecklistDraft(data.orgId, data.serviceDate, data.showId);
  });

/** Apply only selected server-generated suggestions, re-deriving them to reject invented client input. */
export const applySmartChecklistDraft = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        showId: idSchema,
        suggestionIds: z.array(z.string().min(1).max(100)).max(30),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const requested = new Set(data.suggestionIds);
    const draft = await buildSmartChecklistDraft(
      data.orgId,
      data.serviceDate,
      data.showId,
    );
    const selected = draft.filter((suggestion) => requested.has(suggestion.id));
    let added = 0;

    for (const suggestion of selected) {
      const template: ChecklistTemplateWrite = suggestion.existingTemplateId
        ? {
            kind: "existing",
            id: suggestion.existingTemplateId,
            category: suggestion.category,
          }
        : {
            kind: "new",
            id: await createChecklistTemplateId(data.orgId, suggestion.label),
            label: suggestion.label,
            category: suggestion.category,
          };
      const result = await persistChecklistItem({
        orgId: data.orgId,
        showId: data.showId,
        serviceDate: data.serviceDate,
        template,
      });
      if (result.added) added += 1;
    }

    return { added };
  });

// ─── Incidents ──────────────────────────────────────────────

export const getIncidents = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        showId: idSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, [
      "incidents:report",
      "incidents:access",
    ]);
    const prisma = getPrisma();
    return await prisma.incident.findMany({
      where: {
        orgId: data.orgId,
        ...(data.showId
          ? { showId: data.showId }
          : { serviceDate: data.serviceDate }),
      },
      orderBy: { timestamp: "desc" },
    });
  });

export const addIncident = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        category: z.string().max(100),
        severity: z.string().max(50),
        description: longTextSchema,
        reportedBy: z.string().max(200),
        serviceDate: serviceDateSchema,
        showId: idSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, [
      "incidents:report",
      "incidents:access",
    ]);
    const prisma = getPrisma();
    const show = await prisma.rundown.findFirst({
      where: {
        id: data.showId,
        orgId: data.orgId,
        serviceDate: data.serviceDate,
      },
      select: { id: true },
    });
    if (!show) throw new Error("Show not found");
    const incident = await prisma.incident.create({
      data: {
        orgId: data.orgId,
        showId: data.showId,
        category: data.category,
        severity: data.severity,
        description: data.description,
        reportedBy: data.reportedBy,
        serviceDate: data.serviceDate,
      },
    });
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    const { notifyOperationalEvent } =
      await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: session?.user.id,
      includeLeadership: true,
      category: "incidents",
      type: "incident-created",
      severity:
        data.severity === "critical" || data.severity === "high"
          ? "critical"
          : "warning",
      title: `New ${data.severity} ${data.category} issue`,
      message: data.description.slice(0, 240),
      actionUrl: `production/incidents?date=${encodeURIComponent(data.serviceDate)}&show=${encodeURIComponent(data.showId)}&incident=${encodeURIComponent(incident.id)}`,
      source: incident.id,
      pushTag: `incident-${incident.id}`,
    });
    return incident;
  });

export const updateIncident = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z
          .object({
            category: z.string().max(100),
            severity: z.string().max(50),
            description: longTextSchema,
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "incidents:access");
    const prisma = getPrisma();
    const existing = await prisma.incident.findFirst({
      where: { id: data.id, orgId: data.orgId },
      select: { id: true },
    });
    if (!existing) throw new Error("Incident not found");
    const incident = await prisma.incident.update({
      where: { id: data.id },
      data: data.updates,
    });
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({
      headers: getRequestHeaders(),
    });
    const { notifyOperationalEvent } =
      await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: session?.user.id,
      includeLeadership: true,
      category: "incidents",
      type: "incident-updated",
      severity:
        incident.severity === "critical" || incident.severity === "high"
          ? "critical"
          : "warning",
      title: "Operational issue updated",
      message: incident.description.slice(0, 240),
      actionUrl: `production/incidents?date=${encodeURIComponent(incident.serviceDate)}${incident.showId ? `&show=${encodeURIComponent(incident.showId)}` : ""}&incident=${encodeURIComponent(incident.id)}`,
      source: incident.id,
      pushTag: `incident-${incident.id}`,
    });
    return incident;
  });

export const deleteIncident = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "incidents:access");
    const prisma = getPrisma();
    const result = await prisma.incident.deleteMany({
      where: { id: data.id, orgId: data.orgId },
    });
    if (result.count === 0) throw new Error("Incident not found");
  });

// ─── Mic Assignments ────────────────────────────────────────

export const getMicAssignments = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        showId: idSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "dashboard:tm");
    const prisma = getPrisma();
    return await prisma.micAssignment.findMany({
      where: {
        orgId: data.orgId,
        ...(data.showId
          ? { showId: data.showId }
          : { serviceDate: data.serviceDate }),
      },
      orderBy: { channel: "asc" },
    });
  });

const micAssignmentFieldsSchema = z.object({
  channel: z.number().int().min(0).max(10_000),
  label: z.string().max(200),
  micType: z.string().max(100),
  micModel: z.string().max(200),
  notes: longTextSchema,
  gainDb: z.number().min(-200).max(200).nullable(),
  phantom: z.boolean(),
  muted: z.boolean(),
  group: z.string().max(100),
  mixerConsole: z.string().max(200),
  mixerChannel: z.number().int().min(0).max(10_000).nullable(),
  mixerChannelType: z.string().max(100),
});

export const addMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      micAssignmentFieldsSchema.partial().extend({
        orgId: idSchema,
        channel: z.number().int().min(0).max(10_000),
        label: z.string().max(200),
        micType: z.string().max(100),
        serviceDate: serviceDateSchema,
        showId: idSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "dashboard:tm");
    const prisma = getPrisma();
    const show = await prisma.rundown.findFirst({
      where: {
        id: data.showId,
        orgId: data.orgId,
        serviceDate: data.serviceDate,
      },
      select: { id: true },
    });
    if (!show) throw new Error("Show not found");
    return await prisma.micAssignment.create({
      data: {
        orgId: data.orgId,
        showId: data.showId,
        channel: data.channel,
        label: data.label,
        micType: data.micType,
        micModel: data.micModel ?? "",
        notes: data.notes ?? "",
        gainDb: data.gainDb ?? null,
        phantom: data.phantom ?? false,
        muted: data.muted ?? false,
        group: data.group ?? "other",
        mixerConsole: data.mixerConsole ?? "",
        mixerChannel: data.mixerChannel ?? null,
        mixerChannelType: data.mixerChannelType ?? "",
        serviceDate: data.serviceDate,
      },
    });
  });

export const updateMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: micAssignmentFieldsSchema.partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "dashboard:tm");
    const prisma = getPrisma();
    const result = await prisma.micAssignment.updateMany({
      where: { id: data.id, orgId: data.orgId },
      data: data.updates,
    });
    if (result.count === 0) throw new Error("Mic assignment not found");
    return result;
  });

export const deleteMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "dashboard:tm");
    const prisma = getPrisma();
    const result = await prisma.micAssignment.deleteMany({
      where: { id: data.id, orgId: data.orgId },
    });
    if (result.count === 0) throw new Error("Mic assignment not found");
  });

// ─── Equipment ──────────────────────────────────────────────

export const getEquipment = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "assets:view");
    const prisma = getPrisma();
    return await prisma.equipment.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

const equipmentFieldsSchema = z.object({
  name: nameSchema,
  category: z.enum(EQUIPMENT_CATEGORIES),
  status: z.enum(EQUIPMENT_STATUSES),
  location: z.string().max(200),
  serialNumber: z.string().max(200),
  notes: longTextSchema,
});

export const addEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      equipmentFieldsSchema.partial().extend({
        orgId: idSchema,
        name: nameSchema,
        category: z.enum(EQUIPMENT_CATEGORIES),
        quantity: z.number().int().min(1).max(100).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "assets:manage");
    const prisma = getPrisma();
    const quantity = data.quantity ?? 1;
    const unit = {
      orgId: data.orgId,
      name: data.name,
      category: data.category,
      status: data.status ?? "operational",
      location: data.location ?? "",
      // A serial number identifies one physical unit. Never duplicate it
      // across a bulk-created group; operators can assign each unit's serial
      // from its individual editor after creation.
      serialNumber: quantity === 1 ? (data.serialNumber ?? "") : "",
      notes: data.notes ?? "",
    };
    return await prisma.equipment.createMany({
      data: Array.from({ length: quantity }, () => ({ ...unit })),
    });
  });

export const updateEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        expectedRevision: z.number().int().min(0),
        updates: equipmentFieldsSchema.partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "assets:manage");
    const prisma = getPrisma();
    const result = await prisma.equipment.updateMany({
      where: {
        id: data.id,
        orgId: data.orgId,
        revision: data.expectedRevision,
      },
      data: { ...data.updates, revision: { increment: 1 } },
    });
    if (result.count === 1) {
      return { ok: true as const, revision: data.expectedRevision + 1 };
    }
    const current = await prisma.equipment.findFirst({
      where: { id: data.id, orgId: data.orgId },
      select: {
        id: true,
        name: true,
        category: true,
        status: true,
        location: true,
        serialNumber: true,
        notes: true,
        revision: true,
      },
    });
    if (!current) throw new Error("Equipment not found");
    return { ok: false as const, conflict: true as const, current };
  });

export const deleteEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        expectedRevision: z.number().int().min(0),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "assets:manage");
    const prisma = getPrisma();
    const result = await prisma.equipment.deleteMany({
      where: {
        id: data.id,
        orgId: data.orgId,
        revision: data.expectedRevision,
      },
    });
    if (result.count === 1) return { ok: true as const };
    const exists = await prisma.equipment.count({
      where: { id: data.id, orgId: data.orgId },
    });
    if (exists === 0) throw new Error("Equipment not found");
    return { ok: false as const, conflict: true as const };
  });

// ─── Devices ───────────────────────────────────────────────

export const getDevice = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; id: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    return await prisma.device.findFirst({
      where: { id: data.id, orgId: data.orgId },
    });
  });

export const getDevices = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    return await prisma.device.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

export const addDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        name: nameSchema,
        category: z.string().max(100),
        adapterType: z.string().max(100).optional(),
        settings: z.string().max(20_000).optional(),
        enabled: z.boolean().optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();

    const { checkPlanLimit } = await import("@/lib/plan-limits");
    const deviceCount = await prisma.device.count({
      where: { orgId: data.orgId },
    });
    await checkPlanLimit(data.orgId, "devices", deviceCount);

    return await prisma.device.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        category: data.category,
        adapterType: data.adapterType ?? "",
        settings: data.settings ?? "{}",
        enabled: data.enabled ?? true,
      },
    });
  });

export const updateDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z
          .object({
            name: nameSchema,
            category: z.string().max(100),
            adapterType: z.string().max(100),
            settings: z.string().max(20_000),
            enabled: z.boolean(),
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    return await prisma.device.updateMany({
      where: { id: data.id, orgId: data.orgId },
      data: data.updates,
    });
  });

export const deleteDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    await prisma.device.deleteMany({
      where: { id: data.id, orgId: data.orgId },
    });
  });
