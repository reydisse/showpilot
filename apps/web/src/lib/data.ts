import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

const nameSchema = z.string().min(1).max(200);
const shortTextSchema = z.string().max(500);
const longTextSchema = z.string().max(10_000);
// Photos arrive as data URLs; the public flow re-checks decoded byte size.
const photoUrlSchema = z.string().max(2_100_000);

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
  const role = await getOrgMemberRole(orgId);
  const allowed = hasAnyPermission(role, Array.isArray(permission) ? permission : [permission]);
  if (!allowed) throw new Error("Forbidden");
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
    return await prisma.crewMember.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.crewMember.delete({ where: { id: data.id } });
  });

export const toggleCheckIn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema, isOnline: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const now = new Date();
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
    await assertOrgAccess(data.orgId);
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
    return await prisma.checklistTemplate.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    await prisma.checklistTemplate.delete({ where: { id: data.id } });
  });

export const getChecklistEntries = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["checklist:view", "checklist:access"]);
    const prisma = getPrisma();
    return await prisma.checklistEntry.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
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
        checkedBy: z.string().max(200).nullable(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    return await prisma.checklistEntry.update({
      where: { id: data.id },
      data: {
        checked: data.checked,
        checkedBy: data.checkedBy,
        checkedAt: data.checked ? new Date() : null,
      },
    });
  });

export const addChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, templateId: idSchema, serviceDate: serviceDateSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const prisma = getPrisma();
    return await prisma.checklistEntry.create({
      data: {
        orgId: data.orgId,
        templateId: data.templateId,
        serviceDate: data.serviceDate,
      },
    });
  });

// ─── Cue Sheets ─────────────────────────────────────────────

export const getCueSheets = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.cueSheet.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
      orderBy: { cueNumber: "asc" },
    });
  });

export const addCueSheet = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        cueNumber: z.number().int().min(0).max(100_000),
        rundownItem: shortTextSchema,
        cameraAssignments: shortTextSchema.optional(),
        notes: longTextSchema.optional(),
        serviceDate: serviceDateSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.cueSheet.create({
      data: {
        orgId: data.orgId,
        cueNumber: data.cueNumber,
        rundownItem: data.rundownItem,
        cameraAssignments: data.cameraAssignments ?? "",
        notes: data.notes ?? "",
        serviceDate: data.serviceDate,
      },
    });
  });

export const updateCueSheet = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        id: idSchema,
        updates: z
          .object({
            cueNumber: z.number().int().min(0).max(100_000),
            rundownItem: shortTextSchema,
            cameraAssignments: shortTextSchema,
            notes: longTextSchema,
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.cueSheet.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Cue sheet not found");
    await assertOrgAccess(existing.orgId);
    return await prisma.cueSheet.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteCueSheet = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.cueSheet.findUnique({
      where: { id: data.id },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Cue sheet not found");
    await assertOrgAccess(existing.orgId);
    await prisma.cueSheet.delete({ where: { id: data.id } });
  });

// ─── Incidents ──────────────────────────────────────────────

export const getIncidents = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["incidents:report", "incidents:access"]);
    const prisma = getPrisma();
    return await prisma.incident.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
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
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, ["incidents:report", "incidents:access"]);
    const prisma = getPrisma();
    return await prisma.incident.create({
      data: {
        orgId: data.orgId,
        category: data.category,
        severity: data.severity,
        description: data.description,
        reportedBy: data.reportedBy,
        serviceDate: data.serviceDate,
      },
    });
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
    return await prisma.incident.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteIncident = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "incidents:access");
    const prisma = getPrisma();
    await prisma.incident.delete({ where: { id: data.id } });
  });

// ─── Mic Assignments ────────────────────────────────────────

export const getMicAssignments = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.micAssignment.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
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
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.micAssignment.create({
      data: {
        orgId: data.orgId,
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
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.equipment.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        category: data.category,
        status: data.status ?? "operational",
        location: data.location ?? "",
        serialNumber: data.serialNumber ?? "",
        notes: data.notes ?? "",
      },
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
