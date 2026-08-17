import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { parseOrThrow } from "@/lib/validation";
import { orgTerminologyProfileSchema } from "@/lib/org-terminology";
import { getTodayDateString } from "@/lib/utils";

const publicTokenSchema = z
  .string()
  .min(32)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sendCrewScheduleInvite(input: {
  orgId: string;
  assignmentId: string;
  crewMemberId: string;
  serviceDate: string;
  role: string;
  origin: string;
  reminder?: boolean;
}) {
  const prisma = getPrisma();
  const [crew, org, rundown, terminologySetting] = await Promise.all([
    prisma.crewMember.findFirst({
      where: { id: input.crewMemberId, orgId: input.orgId },
      select: { name: true, email: true },
    }),
    prisma.organization.findUnique({
      where: { id: input.orgId },
      select: { name: true },
    }),
    prisma.rundown.findFirst({
      where: { orgId: input.orgId, serviceDate: input.serviceDate },
      select: { name: true, scheduledStartTime: true, location: true },
    }),
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: input.orgId, key: "terminology-profile" } },
      select: { value: true },
    }),
  ]);
  if (!crew?.email || !org)
    return { delivered: false, reason: "missing-email" as const };

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = toBase64Url(bytes);
  const hash = await tokenHash(token);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + 90 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const db = getD1();
  // Keep previously delivered links valid. Every delivery receives a new
  // independently revocable token; all expire automatically after 90 days.
  await db
    .prepare(
      "INSERT INTO crew_schedule_access (id, orgId, crewMemberId, tokenHash, expiresAt) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), input.orgId, input.crewMemberId, hash, expiresAt)
    .run();

  const link = `${input.origin}/crew/schedule/${token}?assignment=${encodeURIComponent(input.assignmentId)}`;
  const serviceName = rundown?.name || "Service";
  const start = rundown?.scheduledStartTime
    ? new Date(rundown.scheduledStartTime).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "Time to be confirmed";
  const parsedTerminology = orgTerminologyProfileSchema.safeParse(
    terminologySetting?.value,
  );
  const { crewScheduleEmail, sendEmail } = await import("@/lib/email");
  const email = crewScheduleEmail({
    orgName: org.name,
    serviceName,
    serviceDate: input.serviceDate,
    start,
    role: input.role,
    location: rundown?.location,
    link,
    reminder: input.reminder,
    terminologyProfile: parsedTerminology.success
      ? parsedTerminology.data
      : "general",
  });
  await sendEmail({
    to: crew.email,
    ...email,
  });
  return { delivered: true, reason: null };
}

type PortalAssignmentRow = {
  id: string;
  serviceDate: string;
  role: string;
  status: string;
  notes: string;
  invitedAt: string | null;
  respondedAt: string | null;
};

async function resolvePortal(token: string) {
  const hash = await tokenHash(token);
  const access = await getD1()
    .prepare(
      "SELECT id, orgId, crewMemberId, expiresAt FROM crew_schedule_access WHERE tokenHash = ? AND revokedAt IS NULL LIMIT 1",
    )
    .bind(hash)
    .first<{
      id: string;
      orgId: string;
      crewMemberId: string;
      expiresAt: string;
    }>();
  if (!access || new Date(access.expiresAt).getTime() <= Date.now())
    throw new Error("This schedule link is invalid or has expired");
  await getD1()
    .prepare(
      "UPDATE crew_schedule_access SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(access.id)
    .run();
  return access;
}

function calendarStamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function calendarText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export async function getCrewScheduleCalendar(
  token: string,
  assignmentId: string,
) {
  const parsedToken = publicTokenSchema.parse(token);
  const parsedAssignmentId = z.string().min(1).max(128).parse(assignmentId);
  const access = await resolvePortal(parsedToken);
  const assignment = await getPrisma().serviceAssignment.findFirst({
    where: {
      id: parsedAssignmentId,
      orgId: access.orgId,
      crewMemberId: access.crewMemberId,
    },
    select: { id: true, serviceDate: true, role: true, notes: true },
  });
  if (!assignment) throw new Error("Assignment not found");
  const rundown = await getPrisma().rundown.findFirst({
    where: { orgId: access.orgId, serviceDate: assignment.serviceDate },
    select: { name: true, scheduledStartTime: true, location: true },
  });
  const start =
    rundown?.scheduledStartTime ??
    new Date(`${assignment.serviceDate}T09:00:00Z`);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const title = `${rundown?.name || "Service"} — ${assignment.role}`;
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "PRODID:-//ShowPilot//Crew Schedule//EN",
    "BEGIN:VEVENT",
    `UID:${assignment.id}@showpilot.tech`,
    `DTSTAMP:${calendarStamp(new Date())}`,
    `DTSTART:${calendarStamp(start)}`,
    `DTEND:${calendarStamp(end)}`,
    `SUMMARY:${calendarText(title)}`,
    ...(rundown?.location
      ? [`LOCATION:${calendarText(rundown.location)}`]
      : []),
    `DESCRIPTION:${calendarText(assignment.notes || `Scheduled as ${assignment.role}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const filename = `${
    (rundown?.name || "showpilot-service")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "showpilot-service"
  }.ics`;
  return { content, filename };
}

export const getCrewSchedulePortal = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ token: publicTokenSchema }), value),
  )
  .handler(async ({ data }) => {
    const access = await resolvePortal(data.token);
    const prisma = getPrisma();
    const [crew, org, settings] = await Promise.all([
      prisma.crewMember.findFirst({
        where: { id: access.crewMemberId, orgId: access.orgId },
        select: { name: true },
      }),
      prisma.organization.findUnique({
        where: { id: access.orgId },
        select: { name: true },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: access.orgId,
          key: { in: ["terminology-profile", "org-timezone"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const today = getTodayDateString(settingMap["org-timezone"]);
    const threshold = new Date(`${today}T12:00:00`);
    threshold.setDate(threshold.getDate() - 1);
    const assignments = await getD1()
      .prepare(
        "SELECT id, serviceDate, role, status, notes, invitedAt, respondedAt FROM service_assignment WHERE orgId = ? AND crewMemberId = ? AND serviceDate >= ? ORDER BY CASE WHEN serviceDate >= ? THEN 0 ELSE 1 END, serviceDate ASC LIMIT 20",
      )
      .bind(
        access.orgId,
        access.crewMemberId,
        threshold.toISOString().slice(0, 10),
        today,
      )
      .all<PortalAssignmentRow>();
    const rows = assignments.results ?? [];
    const dates = [...new Set(rows.map((row) => row.serviceDate))];
    const rundowns = dates.length
      ? await prisma.rundown.findMany({
          where: { orgId: access.orgId, serviceDate: { in: dates } },
          select: {
            serviceDate: true,
            name: true,
            scheduledStartTime: true,
            location: true,
          },
        })
      : [];
    const rundownMap = new Map(
      rundowns.map((rundown) => [rundown.serviceDate, rundown]),
    );
    const parsedTerminology = orgTerminologyProfileSchema.safeParse(
      settingMap["terminology-profile"],
    );
    return {
      crewName: crew?.name ?? "Crew member",
      orgName: org?.name ?? "Organization",
      today,
      terminologyProfile: parsedTerminology.success
        ? parsedTerminology.data
        : "general",
      assignments: rows.map((assignment) => {
        const rundown = rundownMap.get(assignment.serviceDate);
        return {
          ...assignment,
          serviceName: rundown?.name || "Show",
          scheduledStartTime:
            rundown?.scheduledStartTime?.toISOString() ?? null,
          location: rundown?.location ?? "",
        };
      }),
    };
  });

export const respondToCrewScheduleInvite = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      z.object({
        token: publicTokenSchema,
        assignmentId: z.string().min(1).max(128),
        response: z.enum(["confirmed", "declined"]),
        reason: z.string().trim().max(500).default(""),
      }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    const access = await resolvePortal(data.token);
    const result = await getD1()
      .prepare(
        "UPDATE service_assignment SET status = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END, respondedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ? AND crewMemberId = ?",
      )
      .bind(
        data.response,
        data.reason,
        data.reason,
        data.assignmentId,
        access.orgId,
        access.crewMemberId,
      )
      .run();
    if (!result.success || result.meta.changes !== 1)
      throw new Error("Assignment not found");
    return { ok: true as const };
  });
