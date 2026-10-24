import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "../db";
import { getCrewSchedulePortal, sendCrewScheduleInvite } from "../crew-schedule";

// Exercise the actual database and email renderer without sending mail.
const delivery = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../email", async (importOriginal) => ({
  ...await importOriginal<typeof import("../email")>(),
  sendEmail: delivery.send,
}));
vi.mock("../assignment-notifications.server", () => ({
  notifyAssignmentRecipient: async () => ({ notified: false }),
}));
// Only the transport wrapper is replaced; handlers use real D1 and Prisma.
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  const chain = { inputValidator: () => chain, handler: (handler: unknown) => handler };
  return chain;
} }));

beforeEach(() => { delivery.send.mockReset().mockResolvedValue(undefined); });

async function fixture() {
  const prisma = getPrisma();
  const orgId = crypto.randomUUID();
  const crewMemberId = crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await prisma.organization.create({ data: { id: orgId, name: "Schedule link test", slug: orgId, createdAt: new Date() } });
  await prisma.crewMember.create({ data: { id: crewMemberId, orgId, memberId: crewMemberId, name: "Test Crew", email: "crew@example.test", role: "Audio" } });
  await prisma.serviceAssignment.create({ data: { id: assignmentId, orgId, crewMemberId, serviceDate: future, role: "Audio" } });
  return { prisma, orgId, crewMemberId, assignmentId, serviceDate: future, role: "Audio", origin: "https://app.showpilot.tech" };
}

async function invite(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await sendCrewScheduleInvite(f)).toEqual({ delivered: true, reason: null });
  const message: unknown = delivery.send.mock.lastCall?.[0];
  if (!message || typeof message !== "object" || !("html" in message) || typeof message.html !== "string") throw new Error("Missing invitation email");
  const match = message.html.match(/https:\/\/app\.showpilot\.tech\/crew\/schedule\/([A-Za-z0-9_-]+)([^"\s<]*)/);
  if (!match) throw new Error("Missing schedule link");
  expect(match[2]).toBe("");
  expect(message.html).not.toContain(f.assignmentId);
  expect(message.html).not.toContain(f.crewMemberId);
  expect(message.html).not.toContain(f.orgId);
  return match[1];
}

describe("private crew schedule invitation links", () => {
  it("opens the invited assignment without query IDs, even beyond the first twenty upcoming assignments", async () => {
    const f = await fixture();
    const earlier = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 21; i++) await f.prisma.serviceAssignment.create({ data: { orgId: f.orgId, crewMemberId: f.crewMemberId, serviceDate: earlier, role: "Lighting" } });
    const token = await invite(f);
    expect(token).toHaveLength(43);
    const portal = await getCrewSchedulePortal({ data: { token } });
    expect(portal.initialAssignmentId).toBe(f.assignmentId);
    expect(portal.assignments[0].id).toBe(f.assignmentId);
    expect(portal.assignments).toHaveLength(20);
  });

  it("keeps legacy access records valid and does not rotate previously delivered tokens", async () => {
    const f = await fixture();
    const first = await invite(f);
    await env.DB.prepare("UPDATE crew_schedule_access SET assignmentId = NULL WHERE orgId = ?").bind(f.orgId).run();
    const second = await invite(f);
    expect(first).not.toBe(second);
    expect((await getCrewSchedulePortal({ data: { token: first } })).initialAssignmentId).toBeNull();
    expect((await getCrewSchedulePortal({ data: { token: second } })).initialAssignmentId).toBe(f.assignmentId);
  });

  it("never treats a stored assignment selection as authority to read another crew or organization", async () => {
    const f = await fixture();
    const other = await fixture();
    const token = await invite(f);
    await env.DB.prepare("UPDATE crew_schedule_access SET assignmentId = ? WHERE orgId = ?").bind(other.assignmentId, f.orgId).run();
    const portal = await getCrewSchedulePortal({ data: { token } });
    expect(portal.assignments.map(row => row.id)).toEqual([f.assignmentId]);
  });

  it("rejects expired and revoked links", async () => {
    const f = await fixture();
    const token = await invite(f);
    await env.DB.prepare("UPDATE crew_schedule_access SET expiresAt = '2000-01-01' WHERE orgId = ?").bind(f.orgId).run();
    await expect(getCrewSchedulePortal({ data: { token } })).rejects.toThrow("invalid or has expired");
    await env.DB.prepare("UPDATE crew_schedule_access SET expiresAt = '2099-01-01', revokedAt = CURRENT_TIMESTAMP WHERE orgId = ?").bind(f.orgId).run();
    await expect(getCrewSchedulePortal({ data: { token } })).rejects.toThrow("invalid or has expired");
  });

  it("removes an undelivered token after email delivery fails", async () => {
    const f = await fixture();
    delivery.send.mockRejectedValueOnce(new Error("Delivery unavailable"));
    await expect(sendCrewScheduleInvite(f)).rejects.toThrow("Delivery unavailable");
    expect(await env.DB.prepare("SELECT id FROM crew_schedule_access WHERE orgId = ?").bind(f.orgId).first()).toBeNull();
  });
});
