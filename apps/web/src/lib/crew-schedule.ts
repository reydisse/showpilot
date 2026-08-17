import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { parseOrThrow } from "@/lib/validation";

const publicTokenSchema = z.string().min(32).max(160).regex(/^[A-Za-z0-9_-]+$/);

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sendCrewScheduleInvite(input: { orgId: string; assignmentId: string; crewMemberId: string; serviceDate: string; role: string; origin: string; reminder?: boolean }) {
  const prisma = getPrisma();
  const [crew, org, rundown] = await Promise.all([
    prisma.crewMember.findFirst({ where: { id: input.crewMemberId, orgId: input.orgId }, select: { name: true, email: true } }),
    prisma.organization.findUnique({ where: { id: input.orgId }, select: { name: true } }),
    prisma.rundown.findFirst({ where: { orgId: input.orgId, serviceDate: input.serviceDate }, select: { name: true, scheduledStartTime: true } }),
  ]);
  if (!crew?.email || !org) return { delivered: false, reason: "missing-email" as const };

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = toBase64Url(bytes);
  const hash = await tokenHash(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const db = getD1();
  // Keep previously delivered links valid. Every delivery receives a new
  // independently revocable token; all expire automatically after 90 days.
  await db.prepare("INSERT INTO crew_schedule_access (id, orgId, crewMemberId, tokenHash, expiresAt) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), input.orgId, input.crewMemberId, hash, expiresAt).run();

  const link = `${input.origin}/crew/schedule/${token}?assignment=${encodeURIComponent(input.assignmentId)}`;
  const serviceName = rundown?.name || "Service";
  const start = rundown?.scheduledStartTime ? new Date(rundown.scheduledStartTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Time to be confirmed";
  const { crewScheduleEmail, sendEmail } = await import("@/lib/email");
  const email = crewScheduleEmail({
    orgName: org.name,
    serviceName,
    serviceDate: input.serviceDate,
    start,
    role: input.role,
    link,
    reminder: input.reminder,
  });
  await sendEmail({
    to: crew.email,
    ...email,
  });
  return { delivered: true, reason: null };
}

type PortalAssignmentRow = { id: string; serviceDate: string; role: string; status: string; notes: string; invitedAt: string | null; respondedAt: string | null };

async function resolvePortal(token: string) {
  const hash = await tokenHash(token);
  const access = await getD1().prepare("SELECT id, orgId, crewMemberId, expiresAt FROM crew_schedule_access WHERE tokenHash = ? AND revokedAt IS NULL LIMIT 1").bind(hash).first<{ id: string; orgId: string; crewMemberId: string; expiresAt: string }>();
  if (!access || new Date(access.expiresAt).getTime() <= Date.now()) throw new Error("This schedule link is invalid or has expired");
  await getD1().prepare("UPDATE crew_schedule_access SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?").bind(access.id).run();
  return access;
}

export const getCrewSchedulePortal = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ token: publicTokenSchema }), value))
  .handler(async ({ data }) => {
    const access = await resolvePortal(data.token);
    const prisma = getPrisma();
    const [crew, org, assignments] = await Promise.all([
      prisma.crewMember.findFirst({ where: { id: access.crewMemberId, orgId: access.orgId }, select: { name: true } }),
      prisma.organization.findUnique({ where: { id: access.orgId }, select: { name: true } }),
      getD1().prepare("SELECT id, serviceDate, role, status, notes, invitedAt, respondedAt FROM service_assignment WHERE orgId = ? AND crewMemberId = ? AND serviceDate >= date('now', '-1 day') ORDER BY serviceDate ASC LIMIT 20").bind(access.orgId, access.crewMemberId).all<PortalAssignmentRow>(),
    ]);
    const rows = assignments.results ?? [];
    const dates = [...new Set(rows.map((row) => row.serviceDate))];
    const rundowns = dates.length ? await prisma.rundown.findMany({ where: { orgId: access.orgId, serviceDate: { in: dates } }, select: { serviceDate: true, name: true, scheduledStartTime: true } }) : [];
    const rundownMap = new Map(rundowns.map((rundown) => [rundown.serviceDate, rundown]));
    return { crewName: crew?.name ?? "Crew member", orgName: org?.name ?? "Organization", assignments: rows.map((assignment) => { const rundown = rundownMap.get(assignment.serviceDate); return { ...assignment, serviceName: rundown?.name || "Service", scheduledStartTime: rundown?.scheduledStartTime?.toISOString() ?? null }; }) };
  });

export const respondToCrewScheduleInvite = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ token: publicTokenSchema, assignmentId: z.string().min(1).max(128), response: z.enum(["confirmed", "declined"]), reason: z.string().trim().max(500).default("") }), value))
  .handler(async ({ data }) => {
    const access = await resolvePortal(data.token);
    const result = await getD1().prepare("UPDATE service_assignment SET status = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END, respondedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ? AND crewMemberId = ?").bind(data.response, data.reason, data.reason, data.assignmentId, access.orgId, access.crewMemberId).run();
    if (!result.success || result.meta.changes !== 1) throw new Error("Assignment not found");
    return { ok: true as const };
  });
