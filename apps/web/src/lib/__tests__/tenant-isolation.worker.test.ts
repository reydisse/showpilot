import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { resolveEffectiveAccess } from "@/lib/effective-access";
import { readMemberVisibleOrgSettings } from "@/lib/settings-read.server";

describe("tenant access isolation with real D1", () => {
  it("keeps membership and temporary grants inside their organization", async () => {
    const createdAt = "2026-08-27T00:00:00.000Z";
    const orgA = "tenant-test-org-a";
    const orgB = "tenant-test-org-b";
    const userA = "tenant-test-user-a";
    const userB = "tenant-test-user-b";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, ?, ?, ?)`,
      ).bind(orgA, "Tenant A", "tenant-test-a", createdAt),
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, createdAt)
         VALUES (?, ?, ?, ?)`,
      ).bind(orgB, "Tenant B", "tenant-test-b", createdAt),
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(userA, "Operator A", "operator-a@tenant.test", createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(userB, "Operator B", "operator-b@tenant.test", createdAt, createdAt),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind("tenant-test-member-a", orgA, userA, "member", createdAt),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind("tenant-test-member-b", orgB, userB, "admin", createdAt),
      env.DB.prepare(
        `INSERT INTO member_permission_grant
         (id, orgId, userId, capability, permissions, startsOn, expiresOn,
          reason, grantedByUserId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "tenant-test-cross-org-grant",
        orgB,
        userA,
        "asset-manager",
        JSON.stringify(["assets:view", "assets:manage"]),
        "2026-08-01",
        "2026-09-01",
        "Isolation regression fixture",
        userB,
        createdAt,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)`,
      ).bind("tenant-test-timezone-a", orgA, "org-timezone", "Africa/Accra"),
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)`,
      ).bind("tenant-test-secret-a", orgA, "api-key", "org-a-secret"),
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)`,
      ).bind("tenant-test-timezone-b", orgB, "org-timezone", "America/New_York"),
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)`,
      ).bind("tenant-test-secret-b", orgB, "slack-token", "org-b-secret"),
    ]);

    const accessInOwnOrg = await resolveEffectiveAccess(
      env.DB,
      userA,
      orgA,
      "2026-08-27",
    );
    const accessInOtherOrg = await resolveEffectiveAccess(
      env.DB,
      userA,
      orgB,
      "2026-08-27",
    );
    const otherTenantAdmin = await resolveEffectiveAccess(
      env.DB,
      userB,
      orgB,
      "2026-08-27",
    );
    const memberVisibleSettings = await readMemberVisibleOrgSettings(env.DB, orgA);

    expect(accessInOwnOrg?.role).toBe("member");
    expect(accessInOwnOrg?.grantedPermissions).toEqual([]);
    expect(accessInOwnOrg?.permissions).not.toContain("assets:view");
    expect(accessInOwnOrg?.permissions).not.toContain("assets:manage");
    expect(accessInOtherOrg).toBeNull();
    expect(otherTenantAdmin?.role).toBe("admin");
    expect(otherTenantAdmin?.permissions).toContain("assets:manage");
    expect(memberVisibleSettings).toEqual({ "org-timezone": "Africa/Accra" });
    expect(memberVisibleSettings).not.toHaveProperty("api-key");
    expect(memberVisibleSettings).not.toHaveProperty("slack-token");
  });
});
