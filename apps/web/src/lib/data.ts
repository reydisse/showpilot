import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";

async function assertOrgAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
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
  .inputValidator(
    (data: {
      orgId: string;
      memberId: string;
      name: string;
      role: string;
      photoUrl?: string;
    }) => data
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        memberId: string;
        name: string;
        role: string;
        photoUrl: string;
        isOnline: boolean;
      }>;
    }) => data
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
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.crewMember.delete({ where: { id: data.id } });
  });

export const toggleCheckIn = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; isOnline: boolean }) => data)
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
  .inputValidator((data: { orgId: string; memberId: string }) => data)
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

// ─── Checklist ──────────────────────────────────────────────

export const getChecklistTemplates = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.checklistTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { sortOrder: "asc" },
    });
  });

export const addChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orgId: string; label: string; category: string; sortOrder?: number }) => data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
  .inputValidator(
    (data: { id: string; updates: Partial<{ label: string; category: string; sortOrder: number }> }) => data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.checklistTemplate.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteChecklistTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.checklistTemplate.delete({ where: { id: data.id } });
  });

export const getChecklistEntries = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.checklistEntry.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
      include: { template: true },
    });
  });

export const toggleChecklistEntry = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { id: string; checked: boolean; checkedBy: string | null }) => data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
  .inputValidator(
    (data: { orgId: string; templateId: string; serviceDate: string }) => data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.cueSheet.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
      orderBy: { cueNumber: "asc" },
    });
  });

export const addCueSheet = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      cueNumber: number;
      rundownItem: string;
      cameraAssignments?: string;
      notes?: string;
      serviceDate: string;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        cueNumber: number;
        rundownItem: string;
        cameraAssignments: string;
        notes: string;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.cueSheet.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteCueSheet = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.cueSheet.delete({ where: { id: data.id } });
  });

// ─── Incidents ──────────────────────────────────────────────

export const getIncidents = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.incident.findMany({
      where: { orgId: data.orgId, serviceDate: data.serviceDate },
      orderBy: { timestamp: "desc" },
    });
  });

export const addIncident = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      category: string;
      severity: string;
      description: string;
      reportedBy: string;
      serviceDate: string;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        category: string;
        severity: string;
        description: string;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.incident.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteIncident = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
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

export const addMicAssignment = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      channel: number;
      label: string;
      micType: string;
      micModel?: string;
      notes?: string;
      gainDb?: number | null;
      phantom?: boolean;
      muted?: boolean;
      group?: string;
      mixerConsole?: string;
      mixerChannel?: number | null;
      mixerChannelType?: string;
      serviceDate: string;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        channel: number;
        label: string;
        micType: string;
        micModel: string;
        notes: string;
        gainDb: number | null;
        phantom: boolean;
        muted: boolean;
        group: string;
        mixerConsole: string;
        mixerChannel: number | null;
        mixerChannelType: string;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.micAssignment.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.micAssignment.delete({ where: { id: data.id } });
  });

// ─── Equipment ──────────────────────────────────────────────

export const getEquipment = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.equipment.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

export const addEquipment = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      name: string;
      category: string;
      status?: string;
      location?: string;
      serialNumber?: string;
      notes?: string;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        name: string;
        category: string;
        status: string;
        location: string;
        serialNumber: string;
        notes: string;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.equipment.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteEquipment = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.equipment.delete({ where: { id: data.id } });
  });

// ─── Notifications ──────────────────────────────────────────

export const getNotifications = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; target?: string; limit?: number }) => data)
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      orgId: string;
      type: string;
      severity: string;
      title: string;
      message: string;
      target: string;
      source: string;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.notification.update({
      where: { id: data.id },
      data: { dismissed: true },
    });
  });

// ─── Devices ───────────────────────────────────────────────

export const getDevice = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.device.findUnique({ where: { id: data.id } });
  });

export const getDevices = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.device.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
  });

export const addDevice = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      name: string;
      category: string;
      adapterType?: string;
      settings?: string;
      enabled?: boolean;
    }) => data
  )
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        name: string;
        category: string;
        adapterType: string;
        settings: string;
        enabled: boolean;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.device.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteDevice = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.device.delete({ where: { id: data.id } });
  });
