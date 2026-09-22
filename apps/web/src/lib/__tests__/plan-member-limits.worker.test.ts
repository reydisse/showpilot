import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function createOrg(orgId: string, plan = "free", trialEndsAt: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO organization (id, name, slug, createdAt, plan, trialEndsAt)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
  ).bind(orgId, orgId, orgId, plan, trialEndsAt).run();
}

async function createUser(userId: string) {
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(userId, userId, `${userId}@example.com`).run();
}

async function addMember(orgId: string, index: number) {
  const userId = `${orgId}-user-${index}`;
  await createUser(userId);
  return env.DB.prepare(
    `INSERT INTO member (id, organizationId, userId, role, createdAt)
     VALUES (?, ?, ?, 'member', CURRENT_TIMESTAMP)`,
  ).bind(`${orgId}-member-${index}`, orgId, userId).run();
}

describe("database-enforced organization plan capacity", () => {
  it("rejects a sixth free member even through a direct member insert", async () => {
    const orgId = "limit-free-members";
    await createOrg(orgId);
    for (let index = 0; index < 5; index += 1) await addMember(orgId, index);
    await expect(addMember(orgId, 5)).rejects.toThrow(/organization member limit reached/);
  });

  it("counts pending direct invitations against the free limit", async () => {
    const orgId = "limit-free-invites";
    await createOrg(orgId);
    for (let index = 0; index < 4; index += 1) await addMember(orgId, index);
    const inviterId = `${orgId}-user-0`;
    const insertInvitation = (id: string) => env.DB.prepare(
      `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
       VALUES (?, ?, ?, 'member', 'pending', '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, ?)`,
    ).bind(id, orgId, `${id}@example.com`, inviterId).run();
    await expect(insertInvitation("invite-1")).resolves.toBeDefined();
    await expect(insertInvitation("invite-2")).rejects.toThrow(/organization member limit reached/);
  });

  it("honors paid and active-trial capacity instead of applying the free cap", async () => {
    const starterId = "limit-starter";
    await createOrg(starterId, "starter");
    for (let index = 0; index < 6; index += 1) await addMember(starterId, index);

    const trialId = "limit-trial";
    await createOrg(trialId, "free", "2099-01-01T00:00:00.000Z");
    for (let index = 0; index < 6; index += 1) await addMember(trialId, index);
  });
});
