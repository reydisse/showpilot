import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import type { Permission } from "@/lib/app-permissions";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { deriveChecklistSuggestions, normalizeChecklistLabel } from "@/lib/smart-checklist-rules";
import { getRundownStateForOrg } from "@/lib/rundown";

const nameSchema = z.string().min(1).max(200);
const longTextSchema = z.string().max(10_000);
// Photos arrive as data URLs; the public flow re-checks decoded byte size.
const photoUrlSchema = z.string().max(2_100_000);
const optionalCrewEmailSchema = z.union([z.literal(""), z.email("Enter a valid email address").max(254)]);

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true, role: true },
  });
  if (!member) throw new Error("Forbidden");

  return member.role ?? "member";
}

async function assertOrgAccess(orgId: string) {
  await getOrgMemberRole(orgId);
}

async function assertOrgPermission(orgId: string, permission: Permission | Permission[]) {
  await assertEffectiveOrgPermission(orgId, permission);
}

// ─── Crew Members ───────────────────────────────────────────

export const getCrewMembers = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
    await assertOrgAccess(data.orgId);
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
    await assertOrgAccess(data.orgId);
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
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const result = await prisma.crewMember.deleteMany({
      where: { id: data.id, orgId: data.orgId },
    });
    if (result.count === 0) throw new Error("Crew member not found");
  });

export const toggleCheckIn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema, isOnline: z.boolean() }), data),
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
        ...(data.isOnline
          ? { lastCheckOut: now }
          : { lastCheckIn: now }),
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
        ...(member.isOnline
          ? { lastCheckOut: now }
          : { lastCheckIn: now }),
      },
    });
    return { name: updated.name, photoUrl: updated.photoUrl, role: updated.role, isOnline: updated.isOnline };
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
    parseOrThrow(z.object({ slug: z.string().min(1).max(64), memberId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.slug },
      select: { id: true },
    });
    if (!org) return null;

    const member = await prisma.crewMember.findUnique({
      where: { orgId_memberId: { orgId: org.id, memberId: data.memberId } },
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
      memberId: updated.memberId,
      photoUrl: updated.photoUrl,
      role: updated.role,
      isOnline: updated.isOnline,
    };
  });

const ALLOWED_PROFILE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
]);
const MAX_PROFILE_BYTES = 1_500_000;

const getPhotoPayloadBytes = (photoUrl: string) => {
  const match = /^data:([^;]+);base64,/.exec(photoUrl);
  if (!match) return null;

  const mimeType = match[1]?.toLowerCase();
  if (!mimeType || !ALLOWED_PROFILE_MIME_TYPES.has(mimeType)) return null;

  const payload = photoUrl.slice(match[0].length);
  if (!payload || !/^[A-Za-z0-9+/=]+$/.test(payload)) return null;

  return Math.floor((payload.length * 3) / 4);
};

export const updatePublicCrewMemberPhotoByMemberId = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        slug: z.string().min(1).max(64),
        memberId: idSchema,
        photoUrl: photoUrlSchema.optional(),
        name: z.string().max(100).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    const hasName = typeof data.name === "string";
    const hasPhoto = typeof data.photoUrl === "string" && data.photoUrl.length > 0;

    if (!hasName && !hasPhoto) {
      return null;
    }

    const trimmedName = hasName ? data.name!.trim() : "";

    if (hasName && (!trimmedName || trimmedName.length > 80)) {
      return null;
    }

    if (hasPhoto) {
      const photoBytes = getPhotoPayloadBytes(data.photoUrl!);
      if (!photoBytes || photoBytes > MAX_PROFILE_BYTES) {
        return null;
      }
    }

    if (!data.memberId || typeof data.memberId !== "string") {
      return null;
    }

    const updates: { name?: string; photoUrl?: string } = {};

    if (hasName) {
      updates.name = trimmedName;
    }

    if (hasPhoto) {
      updates.photoUrl = data.photoUrl!;
    }

    if (Object.keys(updates).length === 0) {
      return null;
    }

    const org = await prisma.organization.findUnique({
      where: { slug: data.slug },
      select: { id: true },
    });
    if (!org) return null;

    try {
      const updated = await prisma.crewMember.update({
        where: { orgId_memberId: { orgId: org.id, memberId: data.memberId } },
        data: updates,
      });

      return {
        memberId: updated.memberId,
        photoUrl: updated.photoUrl,
        name: updated.name,
      };
    } catch {
      return null;
    }
  });

export const getPublicCrewMemberByMemberId = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string; memberId: string }) => data)
  .handler(async ({ data }) => {
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

export const getChecklistTemplates = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["checklist:view", "checklist:access"]);
    const prisma = getPrisma();
    return await prisma.checklistTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { sortOrder: "asc" },
    });
  });

export const addChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        label: labelSchema,
        category: z.string().max(100),
        sortOrder: z.number().int().optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    return await prisma.checklistTemplate.create({
      data: {
        orgId: data.orgId,
        label: data.label,
        category: data.category,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  });

export const updateChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z
          .object({ label: labelSchema, category: z.string().max(100), sortOrder: z.number().int() })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    // updateMany, not update: the permission check proves the caller may
    // edit checklists in *their* org, not that this row belongs to it.
    // Scoping the write by orgId as well means a borrowed id from
    // another tenant matches nothing instead of being rewritten.
    const result = await prisma.checklistTemplate.updateMany({
      where: { id: data.id, orgId: data.orgId },
      data: data.updates,
    });
    if (result.count === 0) throw new Error("Checklist item not found");
  });

export const deleteChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    // Scoped by orgId for the same reason as the update above.
    await prisma.checklistTemplate.deleteMany({ where: { id: data.id, orgId: data.orgId } });
  });

export const getChecklistEntries = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["checklist:view", "checklist:access"]);
    const prisma = getPrisma();
    return await prisma.checklistEntry.findMany({
      where: { orgId: data.orgId, ...(data.showId ? { showId: data.showId } : { serviceDate: data.serviceDate }) },
      include: { template: true },
    });
  });

export const toggleChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        checked: z.boolean(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("Unauthorized");
    const prisma = getPrisma();
    const result = await prisma.checklistEntry.updateMany({
      where: { id: data.id, orgId: data.orgId },
      data: {
        checked: data.checked,
        // Never trust a client-supplied name. The authenticated actor is the
        // source of truth for checklist attribution.
        checkedBy: data.checked ? session.user.name : null,
        checkedAt: data.checked ? new Date() : null,
      },
    });
    if (result.count === 0) throw new Error("Checklist entry not found");
  });

export const addChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, templateId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    const template = await prisma.checklistTemplate.findFirst({
      where: { id: data.templateId, orgId: data.orgId },
      select: { id: true },
    });
    if (!template) throw new Error("Checklist template not found");
    if (data.showId) {
      const show = await prisma.rundown.findFirst({
        where: { id: data.showId, orgId: data.orgId, serviceDate: data.serviceDate },
        select: { id: true },
      });
      if (!show) throw new Error("Show not found");
    }
    return await prisma.checklistEntry.create({
      data: {
        orgId: data.orgId,
        showId: data.showId,
        templateId: data.templateId,
        serviceDate: data.serviceDate,
      },
    });
  });

export type SmartChecklistDraft = ReturnType<typeof deriveChecklistSuggestions>[number] & {
  existingTemplateId: string | null;
};

async function buildSmartChecklistDraft(orgId: string, serviceDate: string, showId?: string): Promise<SmartChecklistDraft[]> {
  const prisma = getPrisma();
  const [rundown, templates, entries] = await Promise.all([
    getRundownStateForOrg({ orgId, serviceDate, showId }),
    prisma.checklistTemplate.findMany({ where: { orgId }, orderBy: { sortOrder: "asc" } }),
    prisma.checklistEntry.findMany({ where: { orgId, ...(showId ? { showId } : { serviceDate }) }, select: { templateId: true } }),
  ]);
  const entryTemplateIds = new Set(entries.map((entry) => entry.templateId));
  const templatesByLabel = new Map(
    templates.map((template) => [normalizeChecklistLabel(template.label), template]),
  );

  return deriveChecklistSuggestions(rundown.items).flatMap((suggestion) => {
    const existing = templatesByLabel.get(normalizeChecklistLabel(suggestion.label));
    if (existing && entryTemplateIds.has(existing.id)) return [];
    return [{ ...suggestion, existingTemplateId: existing?.id ?? null }];
  });
}

/** Generate a reviewable draft. This is read-only and never publishes checks. */
export const getSmartChecklistDraft = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }), data),
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
        showId: idSchema.optional(),
        suggestionIds: z.array(z.string().min(1).max(100)).max(30),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const requested = new Set(data.suggestionIds);
    const draft = await buildSmartChecklistDraft(data.orgId, data.serviceDate, data.showId);
    const selected = draft.filter((suggestion) => requested.has(suggestion.id));
    const prisma = getPrisma();
    let added = 0;

    for (const suggestion of selected) {
      let templateId = suggestion.existingTemplateId;
      if (!templateId) {
        const template = await prisma.checklistTemplate.create({
          data: {
            orgId: data.orgId,
            label: suggestion.label,
            category: suggestion.category,
            sortOrder: 0,
          },
        });
        templateId = template.id;
      }

      const duplicate = await prisma.checklistEntry.findFirst({
        where: { orgId: data.orgId, ...(data.showId ? { showId: data.showId } : { serviceDate: data.serviceDate }), templateId },
        select: { id: true },
      });
      if (duplicate) continue;
      await prisma.checklistEntry.create({
        data: { orgId: data.orgId, showId: data.showId, serviceDate: data.serviceDate, templateId },
      });
      added += 1;
    }

    return { added };
  });

// ─── Incidents ──────────────────────────────────────────────

export const getIncidents = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["incidents:report", "incidents:access"]);
    const prisma = getPrisma();
    return await prisma.incident.findMany({
      where: { orgId: data.orgId, ...(data.showId ? { showId: data.showId } : { serviceDate: data.serviceDate }) },
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
    await assertOrgPermission(data.orgId, ["incidents:report", "incidents:access"]);
    const prisma = getPrisma();
    const show = await prisma.rundown.findFirst({
      where: { id: data.showId, orgId: data.orgId, serviceDate: data.serviceDate },
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
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: session?.user.id,
      includeLeadership: true,
      type: "incident-created",
      severity: data.severity === "critical" || data.severity === "high" ? "critical" : "warning",
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
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: session?.user.id,
      includeLeadership: true,
      type: "incident-updated",
      severity: incident.severity === "critical" || incident.severity === "high" ? "critical" : "warning",
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
    parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.micAssignment.findMany({
      where: { orgId: data.orgId, ...(data.showId ? { showId: data.showId } : { serviceDate: data.serviceDate }) },
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
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const show = await prisma.rundown.findFirst({
      where: { id: data.showId, orgId: data.orgId, serviceDate: data.serviceDate },
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
      z.object({ id: idSchema, updates: micAssignmentFieldsSchema.partial() }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.micAssignment.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Mic assignment not found");
    await assertOrgAccess(existing.orgId);
    return await prisma.micAssignment.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.micAssignment.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Mic assignment not found");
    await assertOrgAccess(existing.orgId);
    await prisma.micAssignment.delete({ where: { id: data.id } });
  });

// ─── Equipment ──────────────────────────────────────────────

export const getEquipment = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.equipment.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

const equipmentFieldsSchema = z.object({
  name: nameSchema,
  category: z.string().max(100),
  status: z.string().max(50),
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
        category: z.string().max(100),
        quantity: z.number().int().min(1).max(100).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
      serialNumber: quantity === 1 ? data.serialNumber ?? "" : "",
      notes: data.notes ?? "",
    };
    return await prisma.equipment.createMany({
      data: Array.from({ length: quantity }, () => ({ ...unit })),
    });
  });

export const updateEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ id: idSchema, updates: equipmentFieldsSchema.partial() }), data),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.equipment.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Equipment not found");
    await assertOrgAccess(existing.orgId);
    return await prisma.equipment.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.equipment.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Equipment not found");
    await assertOrgAccess(existing.orgId);
    await prisma.equipment.delete({ where: { id: data.id } });
  });

// ─── Notifications ──────────────────────────────────────────

export const getNotifications = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        target: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.notification.findMany({
      where: {
        orgId: data.orgId,
        dismissed: false,
        ...(data.target && data.target !== "all" ? { target: data.target } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: data.limit ?? 50,
    });
  });

export const writeNotification = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        type: z.string().max(100),
        severity: z.string().max(50),
        title: z.string().max(200),
        message: z.string().max(2000),
        target: z.string().max(100),
        source: z.string().max(100),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.notification.create({
      data: {
        orgId: data.orgId,
        type: data.type,
        severity: data.severity,
        title: data.title,
        message: data.message,
        target: data.target,
        source: data.source,
      },
    });
  });

export const dismissNotification = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.notification.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Notification not found");
    await assertOrgAccess(existing.orgId);
    await prisma.notification.update({
      where: { id: data.id },
      data: { dismissed: true },
    });
  });

// ─── Devices ───────────────────────────────────────────────

export const getDevice = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; id: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    return await prisma.device.findFirst({ where: { id: data.id, orgId: data.orgId } });
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
    const deviceCount = await prisma.device.count({ where: { orgId: data.orgId } });
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
    await prisma.device.deleteMany({ where: { id: data.id, orgId: data.orgId } });
  });
