import { createCrewProfileSchema, updateCrewProfileSchema, deleteCrewProfileSchema } from "./crew-roster-contract";
import { crewActor, readCrewRoster, writeCrewProfile } from "./crew-roster.server";
import { env } from "cloudflare:workers";
import { runAudioWrite } from "./audio-write.server";
import { runDeviceWrite } from "./device-write.server";
import { maskDeviceSettings, writeDeviceSettings } from "./device-settings.server";
import { MAX_DEVICE_LATENCY_MS } from "./automation-timing";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES } from "@showpilot/shared";
import type { Permission } from "@/lib/app-permissions";
import { checklistWriteSchema } from "@/lib/checklist-writes";
import { applyChecklistWrite } from "@/lib/checklist-writes.server";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { getRundownStateForOrg } from "@/lib/rundown";
import {
  deriveChecklistSuggestions,
  normalizeChecklistLabel,
} from "@/lib/smart-checklist-rules";
import {
  idSchema,
  parseOrThrow,
  serviceDateSchema,
} from "@/lib/validation";
import { publicCheckInOrgSchema, publicMemberLookupSchema, publicAttendanceWriteSchema } from "@/lib/public-checkin";
import { applyPublicAttendanceIntent, getPublicAttendanceMember } from "@/lib/public-checkin.server";
import { enforcePublicCheckInRateLimit } from "@/lib/public-checkin-rate-limit.server";

const nameSchema = z.string().min(1).max(200);
const longTextSchema = z.string().max(10_000);

async function assertOrgPermission(
  orgId: string,
  permission: Permission | Permission[],
) {
  await assertEffectiveOrgPermission(orgId, permission);
}

// ─── Crew Members ───────────────────────────────────────────

export const getCrewMembers = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "show:view");
    return readCrewRoster(getD1(), data.orgId);
  });

export const addCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(createCrewProfileSchema, data))
  .handler(async ({ data }) => writeCrewProfile(getD1(), await crewActor(getRequestHeaders()), { ...data, kind: "create" }));

export const updateCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(updateCrewProfileSchema, data))
  .handler(async ({ data }) => writeCrewProfile(getD1(), await crewActor(getRequestHeaders()), { ...data, kind: "update" }));

export const deleteCrewMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(deleteCrewProfileSchema, data))
  .handler(async ({ data }) => writeCrewProfile(getD1(), await crewActor(getRequestHeaders()), { ...data, kind: "delete" }));

export const getPublicCheckInOrg = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(publicCheckInOrgSchema, data))
  .handler(async ({ data }) => getPrisma().organization.findUnique({
    where: { slug: data.slug }, select: { name: true, slug: true },
  }));

export const publicCheckInByMemberId = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(publicAttendanceWriteSchema, data))
  .handler(async ({ data }) => {
    await enforcePublicCheckInRateLimit("write", data.slug, data.memberId);
    const org = await getPrisma().organization.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (!org) throw new Error("Organization not found. Check the check-in link.");
    return applyPublicAttendanceIntent(getD1(), org.id, data);
  });

export const getPublicCrewMemberByMemberId = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(publicMemberLookupSchema, data))
  .handler(async ({ data }) => {
    await enforcePublicCheckInRateLimit("read", data.slug, data.memberId);
    const org = await getPrisma().organization.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (!org) return null;
    return getPublicAttendanceMember(getD1(), org.id, data.memberId);
  });

// ─── Checklist ──────────────────────────────────────────────

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

/** Retry always rechecks authorization, then acknowledges the captured operation. */
export const mutateChecklist = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(checklistWriteSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checklist:access");
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("Unauthorized");
    return applyChecklistWrite(getD1(), data, session.user.name,
      () => buildSmartChecklistDraft(data.orgId, data.serviceDate, data.showId));
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

const writeRequestIdSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional();

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
  .inputValidator((data: unknown) => parseOrThrow(
    micAssignmentFieldsSchema.partial().extend({
      orgId: idSchema, requestId: writeRequestIdSchema,
      channel: z.number().int().min(0).max(10_000), label: z.string().max(200),
      micType: z.string().max(100), serviceDate: serviceDateSchema, showId: idSchema,
    }), data,
  ))
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "dashboard:tm");
    const { requestId, ...payload } = data;
    const id = await runAudioWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "create", payload }, () => {
      const assignmentId = crypto.randomUUID();
      return { assignmentId,
        guard: "EXISTS(SELECT 1 FROM rundown WHERE id=? AND orgId=? AND serviceDate=?)",
        guardValues: [data.showId, data.orgId, data.serviceDate],
        statement: getD1().prepare(`INSERT INTO mic_assignment(id,orgId,showId,channel,label,micType,micModel,notes,gainDb,phantom,muted,"group",mixerConsole,mixerChannel,mixerChannelType,serviceDate,updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(assignmentId,data.orgId,data.showId,data.channel,data.label,data.micType,data.micModel??"",data.notes??"",data.gainDb??null,data.phantom?1:0,data.muted?1:0,data.group??"other",data.mixerConsole??"",data.mixerChannel??null,data.mixerChannelType??"",data.serviceDate,new Date().toISOString()),
      };
    });
    const assignment = await getPrisma().micAssignment.findFirst({ where: { id, orgId: data.orgId } });
    if (!assignment) throw new Error("The saved channel was removed. Retrying will not recreate it.");
    return assignment;
  });

export const updateMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema, id: idSchema, requestId: writeRequestIdSchema, updates: micAssignmentFieldsSchema.partial(),
  }), data))
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "dashboard:tm");
    const { requestId, ...payload } = data;
    await runAudioWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "update", payload }, () => {
      // Zod strips unknown fields. Only parsed assignment columns enter this SQL.
      const fields = Object.entries(data.updates).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined);
      return { assignmentId: data.id,
        guard: "EXISTS(SELECT 1 FROM mic_assignment WHERE id=? AND orgId=?)", guardValues: [data.id, data.orgId],
        statement: getD1().prepare(`UPDATE mic_assignment SET ${fields.map(([key]) => `"${key}"=?`).concat("updatedAt=?").join(",")} WHERE id=? AND orgId=?`)
          .bind(...fields.map(([, value]) => typeof value === "boolean" ? Number(value) : value),new Date().toISOString(),data.id,data.orgId),
      };
    });
    return { count: 1 };
  });

export const deleteMicAssignment = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema, requestId: writeRequestIdSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "dashboard:tm");
    const { requestId, ...payload } = data;
    await runAudioWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "delete", payload }, () => ({
      assignmentId: data.id,
      guard: "EXISTS(SELECT 1 FROM mic_assignment WHERE id=? AND orgId=?)", guardValues: [data.id, data.orgId],
      statement: getD1().prepare("DELETE FROM mic_assignment WHERE id=? AND orgId=?").bind(data.id,data.orgId),
    }));
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
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    const device = await prisma.device.findFirst({
      where: { id: data.id, orgId: data.orgId },
    });
    return device ? { ...device, settings: maskDeviceSettings(device) } : null;
  });

export const getDevices = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "devices:access");
    const prisma = getPrisma();
    const devices = await prisma.device.findMany({
      where: { orgId: data.orgId },
      orderBy: { name: "asc" },
    });
    return devices.map(device => ({ ...device, settings: maskDeviceSettings(device) }));
  });

export const addDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        requestId: writeRequestIdSchema,
        name: nameSchema,
        category: z.string().max(100),
        adapterType: z.string().max(100).optional(),
        settings: z.string().max(20_000).optional(),
        enabled: z.boolean().optional(),
        latencyMs: z.number().int().min(0).max(MAX_DEVICE_LATENCY_MS).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "devices:access");
    const { requestId, ...payload } = data;
    const prisma = getPrisma();
    const id = await runDeviceWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "create", payload }, async () => {
      const { checkPlanLimit } = await import("@/lib/plan-limits");
      const count = await prisma.device.count({ where: { orgId: data.orgId } });
      await checkPlanLimit(data.orgId, "devices", count);
      const identity = { id: crypto.randomUUID(), orgId: data.orgId, adapterType: data.adapterType ?? "" };
      const settings = await writeDeviceSettings(env.CREDENTIAL_ENCRYPTION_KEYS, identity, data.settings ?? "{}");
      return { deviceId: identity.id,
        guard: "(SELECT COUNT(*) FROM device WHERE orgId=?)=?", guardValues: [data.orgId, count],
        statement: getD1().prepare(`INSERT INTO device(id,orgId,name,category,adapterType,settings,enabled,latencyMs,updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?)`).bind(identity.id,data.orgId,data.name,data.category,identity.adapterType,settings,data.enabled === false ? 0 : 1,data.latencyMs ?? 0,new Date().toISOString()),
      };
    });
    const device = await prisma.device.findFirst({ where: { id, orgId: data.orgId } });
    if (!device) throw new Error("The saved device was removed. Retrying will not recreate it.");
    return { ...device, settings: maskDeviceSettings(device) };
  });

export const updateDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        requestId: writeRequestIdSchema,
        id: idSchema,
        clearCredentials: z.array(z.array(z.string().min(1).max(200)).min(1).max(16)).max(100).optional(),
        updates: z
          .object({
            name: nameSchema,
            category: z.string().max(100),
            adapterType: z.string().max(100),
            settings: z.string().max(20_000),
            enabled: z.boolean(),
            latencyMs: z.number().int().min(0).max(MAX_DEVICE_LATENCY_MS),
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "devices:access");
    const { requestId, ...payload } = data;
    await runDeviceWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "update", payload }, async () => {
      // Keep the exact stored timestamp representation for legacy D1 rows too.
      const existing = await getD1().prepare("SELECT settings,adapterType,updatedAt FROM device WHERE id=? AND orgId=?")
        .bind(data.id,data.orgId).first<{ settings: string; adapterType: string; updatedAt: string | number }>();
      if (!existing) throw new Error("Device not found.");
      const adapterType = data.updates.adapterType ?? existing.adapterType;
      const settings = await writeDeviceSettings(env.CREDENTIAL_ENCRYPTION_KEYS,
        { id: data.id, orgId: data.orgId, adapterType }, data.updates.settings ?? "{}",
        adapterType === existing.adapterType ? existing.settings : "{}", data.clearCredentials);
      // Keys come only from the parsed schema, and all values stay bound.
      const fields = Object.entries({ ...data.updates, settings }).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
      return { deviceId: data.id,
        guard: "EXISTS(SELECT 1 FROM device WHERE id=? AND orgId=? AND settings=? AND adapterType=? AND updatedAt=?)",
        guardValues: [data.id,data.orgId,existing.settings,existing.adapterType,existing.updatedAt],
        statement: getD1().prepare(`UPDATE device SET ${fields.map(([key]) => `"${key}"=?`).concat("updatedAt=?").join(",")} WHERE id=? AND orgId=?`)
          .bind(...fields.map(([, value]) => typeof value === "boolean" ? Number(value) : value),new Date().toISOString(),data.id,data.orgId),
      };
    });
    return { count: 1 };
  });

export const deleteDevice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, requestId: writeRequestIdSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const { user } = await assertEffectiveOrgPermission(data.orgId, "devices:access");
    const { requestId, ...payload } = data;
    await runDeviceWrite({ orgId: data.orgId, actorId: user.id, requestId, kind: "delete", payload }, () => ({
      deviceId: data.id,
      guard: "EXISTS(SELECT 1 FROM device WHERE id=? AND orgId=?)", guardValues: [data.id,data.orgId],
      statement: getD1().prepare("DELETE FROM device WHERE id=? AND orgId=?").bind(data.id,data.orgId),
    }));
  });
