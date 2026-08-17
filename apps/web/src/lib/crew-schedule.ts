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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
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
  const { sendEmail } = await import("@/lib/email");
  await sendEmail({
    to: crew.email,
    subject: `${input.reminder ? "Response needed" : "You're scheduled"}: ${serviceName}`,
    html: `<div style="background:#090b0d;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:40px 20px"><div style="max-width:520px;margin:auto"><h2 style="margin:0 0 28px"><span style="color:#ff6a2a">Show</span>Pilot</h2><p style="color:#9ca3af;margin:0 0 8px">${escapeHtml(org.name)}</p><h1 style="font-size:26px;margin:0 0 18px">${input.reminder ? "Can you serve?" : "You've been scheduled"}</h1><div style="border-top:1px solid #292d32;border-bottom:1px solid #292d32;padding:20px 0;margin-bottom:24px"><strong>${escapeHtml(serviceName)}</strong><p style="color:#aeb4bc;line-height:1.7;margin:8px 0 0">${escapeHtml(input.serviceDate)} · ${escapeHtml(start)}<br>${escapeHtml(input.role)}</p></div><a href="${link}" style="display:inline-block;background:#ff6a2a;color:#090b0d;font-weight:700;padding:14px 22px;border-radius:8px;text-decoration:none">Accept or decline</a><p style="color:#6b7280;font-size:12px;line-height:1.6;margin-top:28px">No account is needed. This secure link is unique to you and expires in 90 days.</p></div></div>`,
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
