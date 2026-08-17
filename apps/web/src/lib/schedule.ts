import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

const rangeInput = z.object({
  orgId: idSchema,
  from: serviceDateSchema,
  to: serviceDateSchema,
  selectedDate: serviceDateSchema.optional(),
});

export const scheduleProviderSchema = z.enum(["native", "planning-center", "faithteams", "other"]);
export type ScheduleProvider = z.infer<typeof scheduleProviderSchema>;

const providerConfigInput = z.object({
  orgId: idSchema,
  provider: scheduleProviderSchema,
  url: z.union([z.literal(""), z.string().url().max(500)]),
  label: z.string().trim().max(80).default(""),
});

export const saveScheduleProvider = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(providerConfigInput, value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    if (data.provider !== "native" && !data.url) throw new Error("A scheduling workspace URL is required");
    if (data.url) {
      const url = new URL(data.url);
      if (url.protocol !== "https:") throw new Error("Scheduling links must use HTTPS");
    }
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.appSetting.upsert({ where: { orgId_key: { orgId: data.orgId, key: "schedule-provider" } }, update: { value: data.provider }, create: { orgId: data.orgId, key: "schedule-provider", value: data.provider } }),
      prisma.appSetting.upsert({ where: { orgId_key: { orgId: data.orgId, key: "schedule-provider-url" } }, update: { value: data.url }, create: { orgId: data.orgId, key: "schedule-provider-url", value: data.url } }),
      prisma.appSetting.upsert({ where: { orgId_key: { orgId: data.orgId, key: "schedule-provider-label" } }, update: { value: data.label }, create: { orgId: data.orgId, key: "schedule-provider-label", value: data.label } }),
    ]);
    return { ok: true };
  });

async function assertAccess(orgId: string, manage = false) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({ where: { organizationId: orgId, userId: session.user.id }, select: { role: true } });
  if (!member || !hasAnyPermission(member.role ?? "member", manage ? ["settings:members", "rundown:edit"] : ["rundown:view", "dashboard:pm"])) throw new Error("Forbidden");
  return { userId: session.user.id, email: session.user.email.toLowerCase(), name: session.user.name };
}

export const getSchedule = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(rangeInput, value))
  .handler(async ({ data }) => {
    const viewer = await assertAccess(data.orgId);
    const prisma = getPrisma();
    const dateWhere = { gte: data.from, lte: data.to };
    const [rundowns, items, assignments, checklist, incidents, crew, providerSettings] = await Promise.all([
      prisma.rundown.findMany({ where: { orgId: data.orgId, serviceDate: dateWhere }, orderBy: { serviceDate: "asc" } }),
      prisma.rundownItem.findMany({ where: { orgId: data.orgId, serviceDate: dateWhere }, select: { serviceDate: true, status: true, duration: true, actualStart: true, actualEnd: true } }),
      prisma.serviceAssignment.findMany({ where: { orgId: data.orgId, serviceDate: dateWhere }, include: { crewMember: { select: { id: true, name: true, role: true, email: true } } }, orderBy: { role: "asc" } }),
      prisma.checklistEntry.findMany({ where: { orgId: data.orgId, serviceDate: dateWhere }, select: { serviceDate: true, checked: true } }),
      prisma.incident.findMany({ where: { orgId: data.orgId, serviceDate: dateWhere }, select: { serviceDate: true, status: true } }),
      prisma.crewMember.findMany({ where: { orgId: data.orgId }, select: { id: true, name: true, role: true, email: true }, orderBy: { name: "asc" } }),
      prisma.appSetting.findMany({ where: { orgId: data.orgId, key: { in: ["schedule-provider", "schedule-provider-url", "schedule-provider-label"] } }, select: { key: true, value: true } }),
    ]);
    const providerMap = Object.fromEntries(providerSettings.map((setting) => [setting.key, setting.value]));
    const parsedProvider = scheduleProviderSchema.safeParse(providerMap["schedule-provider"]);
    const provider = parsedProvider.success ? parsedProvider.data : "native";
    const selectedDate = data.selectedDate ?? rundowns[0]?.serviceDate;
    const services = rundowns.map((rundown) => {
      const dayItems = items.filter((item) => item.serviceDate === rundown.serviceDate);
      const dayCrew = assignments.filter((item) => item.serviceDate === rundown.serviceDate);
      const dayChecklist = checklist.filter((item) => item.serviceDate === rundown.serviceDate);
      const completed = dayItems.filter((item) => item.status === "complete").length;
      const confirmed = dayCrew.filter((item) => item.status === "confirmed").length;
      const readinessParts = [dayItems.length ? completed / dayItems.length : 0, dayChecklist.length ? dayChecklist.filter((item) => item.checked).length / dayChecklist.length : 0, dayCrew.length ? confirmed / dayCrew.length : 0];
      return {
        serviceDate: rundown.serviceDate,
        name: rundown.name || "Service",
        scheduledStartTime: rundown.scheduledStartTime?.toISOString() ?? null,
        status: rundown.status,
        itemCount: dayItems.length,
        completedItems: completed,
        plannedDurationMs: dayItems.reduce((sum, item) => sum + item.duration, 0),
        actualStart: dayItems.map((item) => item.actualStart).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0]?.toISOString() ?? null,
        actualEnd: dayItems.map((item) => item.actualEnd).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0]?.toISOString() ?? null,
        crewTotal: dayCrew.length,
        crewConfirmed: confirmed,
        crewOpen: dayCrew.filter((item) => !item.crewMemberId).length,
        checklistTotal: dayChecklist.length,
        checklistComplete: dayChecklist.filter((item) => item.checked).length,
        incidentCount: incidents.filter((item) => item.serviceDate === rundown.serviceDate).length,
        readiness: Math.round(readinessParts.reduce((sum, part) => sum + part, 0) / readinessParts.length * 100),
      };
    });
    return { services, selectedDate: selectedDate ?? null, assignments: assignments.filter((row) => row.serviceDate === selectedDate).map((assignment) => ({ ...assignment, canRespond: Boolean(assignment.crewMember?.email) && assignment.crewMember!.email.toLowerCase() === viewer.email })), crew, provider: { type: provider, url: providerMap["schedule-provider-url"] ?? "", label: providerMap["schedule-provider-label"] ?? "" } };
  });

const assignmentInput = z.object({
  orgId: idSchema,
  id: idSchema.optional(),
  serviceDate: serviceDateSchema,
  role: z.string().trim().min(1).max(120),
  crewMemberId: idSchema.nullable(),
  status: z.enum(["assigned", "confirmed", "declined"]).default("assigned"),
  notes: z.string().trim().max(500).default(""),
});

export const saveServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(assignmentInput, value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    if (data.crewMemberId) {
      const valid = await getPrisma().crewMember.count({ where: { id: data.crewMemberId, orgId: data.orgId } });
      if (!valid) throw new Error("Crew member not found");
    }
    if (data.id) {
      const existing = await getPrisma().serviceAssignment.findFirst({ where: { id: data.id, orgId: data.orgId } });
      if (!existing) throw new Error("Assignment not found");
      const personChanged = existing.crewMemberId !== data.crewMemberId;
      const updated = await getPrisma().serviceAssignment.update({
        where: { id: data.id },
        data: {
          role: data.role,
          crewMemberId: data.crewMemberId,
          notes: data.notes,
          ...(personChanged ? { status: "assigned", respondedAt: null, invitedAt: null } : {}),
        },
      });
      if (personChanged && data.crewMemberId) {
        const delivered = await notifyAssignment(data.orgId, updated.id, updated.serviceDate, updated.role, data.crewMemberId);
        if (delivered) return getPrisma().serviceAssignment.update({ where: { id: updated.id }, data: { invitedAt: new Date() } });
      }
      return updated;
    }
    const assignment = await getPrisma().serviceAssignment.create({ data: { orgId: data.orgId, serviceDate: data.serviceDate, role: data.role, crewMemberId: data.crewMemberId, status: data.status, notes: data.notes, invitedAt: null } });
    if (data.crewMemberId && data.status === "assigned") {
      const delivered = await notifyAssignment(data.orgId, assignment.id, data.serviceDate, data.role, data.crewMemberId);
      if (delivered) return getPrisma().serviceAssignment.update({ where: { id: assignment.id }, data: { invitedAt: new Date() } });
    }
    return assignment;
  });

async function notifyAssignment(orgId: string, assignmentId: string, serviceDate: string, role: string, crewMemberId: string, reminder = false) {
  try {
    const { sendCrewScheduleInvite } = await import("@/lib/crew-schedule");
    const headers = getRequestHeaders();
    const host = headers.get("x-forwarded-host") ?? headers.get("host");
    const protocol = headers.get("x-forwarded-proto") ?? (host?.includes("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
    const origin = headers.get("origin") ?? (host ? `${protocol}://${host}` : "https://showpilot.tech");
    const result = await sendCrewScheduleInvite({ orgId, assignmentId, serviceDate, role, crewMemberId, reminder, origin });
    return result.delivered;
  } catch (error) {
    console.error("[Schedule] Crew invitation delivery failed", error);
    return false;
  }
}

export const remindServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const assignment = await getPrisma().serviceAssignment.findFirst({ where: { id: data.id, orgId: data.orgId, status: "assigned", crewMemberId: { not: null } } });
    if (!assignment?.crewMemberId) throw new Error("Only pending assignments can be reminded");
    const delivered = await notifyAssignment(data.orgId, assignment.id, assignment.serviceDate, assignment.role, assignment.crewMemberId, true);
    if (delivered) await getPrisma().serviceAssignment.update({ where: { id: assignment.id }, data: { invitedAt: new Date() } });
    return { ok: true as const, delivered };
  });

export const remindAllServiceAssignments = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema }), value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const assignments = await getPrisma().serviceAssignment.findMany({ where: { orgId: data.orgId, serviceDate: data.serviceDate, status: "assigned", crewMemberId: { not: null } }, select: { id: true, role: true, crewMemberId: true } });
    const results = await Promise.all(assignments.map(async (assignment) => {
      const delivered = await notifyAssignment(data.orgId, assignment.id, data.serviceDate, assignment.role, assignment.crewMemberId!, true);
      if (delivered) await getPrisma().serviceAssignment.update({ where: { id: assignment.id }, data: { invitedAt: new Date() } });
      return delivered;
    }));
    return { ok: true as const, delivered: results.filter(Boolean).length, total: assignments.length };
  });

export const deleteServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const existing = await getPrisma().serviceAssignment.findFirst({ where: { id: data.id, orgId: data.orgId } });
    if (!existing) throw new Error("Assignment not found");
    await getPrisma().serviceAssignment.delete({ where: { id: data.id } });
    return { ok: true };
  });
