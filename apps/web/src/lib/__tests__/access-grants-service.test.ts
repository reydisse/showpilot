import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAccessManagementSnapshotForActor,
  grantMemberAccessForActor,
  revokeMemberAccessForActor,
} from "../access-grants";

const mocks = vi.hoisted(() => ({
  resolveAuthority: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  grantFindMany: vi.fn(),
  grantFindFirst: vi.fn(),
  databaseRun: vi.fn(),
  notificationCreate: vi.fn(),
}));

vi.mock("../effective-access", () => ({
  resolveAccessGrantAuthority: mocks.resolveAuthority,
  resolveEffectiveAccess: vi.fn(),
}));

vi.mock("../db", () => ({
  getPrisma: () => ({
    member: {
      findMany: mocks.memberFindMany,
      findFirst: mocks.memberFindFirst,
    },
    memberPermissionGrant: {
      findMany: mocks.grantFindMany,
      findFirst: mocks.grantFindFirst,
    },
    notification: { create: mocks.notificationCreate },
  }),
}));

vi.mock("../d1", () => ({ getD1: vi.fn() }));
vi.mock("../org-access", () => ({ getRequestOrgAccess: vi.fn() }));

const databaseCalls: Array<{ sql: string; params: unknown[] }> = [];
const database = {
  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async () => null,
        run: async () => {
          databaseCalls.push({ sql, params });
          return mocks.databaseRun(sql, params);
        },
      }),
    };
  },
};

const permanentAuthority = {
  canManage: true,
  kind: "permanent" as const,
  weekStart: "2026-08-23",
  weekEndExclusive: "2026-08-30",
  today: "2026-08-27",
};

const dutyAuthority = { ...permanentAuthority, kind: "on-duty-tm" as const };

describe("shared access-grant service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseCalls.length = 0;
    mocks.resolveAuthority.mockResolvedValue(permanentAuthority);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.memberFindFirst.mockResolvedValue({ user: { name: "Stage Lead" } });
    mocks.grantFindMany.mockResolvedValue([]);
    mocks.grantFindFirst.mockResolvedValue(null);
    mocks.databaseRun.mockResolvedValue({ success: true, meta: { changes: 1 } });
    mocks.notificationCreate.mockResolvedValue({ id: "notification-1" });
  });

  it("marks only current-week grants revocable for an on-duty TM", async () => {
    mocks.resolveAuthority.mockResolvedValue(dutyAuthority);
    mocks.grantFindMany.mockResolvedValue([
      {
        id: "weekly",
        userId: "member-1",
        capability: "rundown-operator",
        permissions: "[]",
        startsOn: "2026-08-23",
        expiresOn: "2026-08-30",
        reason: "",
        grantedByUserId: "owner-1",
        createdAt: new Date("2026-08-23T00:00:00Z"),
        grantedBy: { name: "Owner" },
      },
      {
        id: "ongoing",
        userId: "member-2",
        capability: "device-operator",
        permissions: "[]",
        startsOn: "2026-08-01",
        expiresOn: null,
        reason: "",
        grantedByUserId: "owner-1",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        grantedBy: { name: "Owner" },
      },
    ]);
    const result = await getAccessManagementSnapshotForActor({
      orgId: "org-1",
      actorUserId: "tm-1",
      database,
    });
    expect(result.grants.map((grant) => [grant.id, grant.canRevoke])).toEqual([
      ["weekly", true],
      ["ongoing", false],
    ]);
  });

  it("prevents an on-duty TM from issuing ongoing access", async () => {
    mocks.resolveAuthority.mockResolvedValue(dutyAuthority);
    await expect(grantMemberAccessForActor({
      orgId: "org-1",
      actor: { userId: "tm-1", name: "Duty TM" },
      userId: "member-1",
      capability: "rundown-operator",
      duration: "until-revoked",
      reason: "",
      database,
    })).rejects.toThrow("current duty week");
    expect(mocks.databaseRun).not.toHaveBeenCalled();
  });

  it("stores the reviewed capability snapshot and duty-week dates", async () => {
    await grantMemberAccessForActor({
      orgId: "org-1",
      actor: { userId: "owner-1", name: "Owner" },
      userId: "member-1",
      capability: "rundown-operator",
      duration: "this-week",
      reason: "Covering Sunday",
      database,
    });
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].sql).toContain("WHERE NOT EXISTS");
    expect(databaseCalls[0].params.slice(4, 9)).toEqual([
      JSON.stringify(["rundown:view", "rundown:edit", "rundown:control"]),
      "2026-08-23",
      "2026-08-30",
      "Covering Sunday",
      "owner-1",
    ]);
    expect(mocks.notificationCreate).toHaveBeenCalledOnce();
  });

  it("converges concurrent duplicate grants without a second notification", async () => {
    mocks.databaseRun.mockResolvedValue({ success: true, meta: { changes: 0 } });
    await expect(grantMemberAccessForActor({
      orgId: "org-1",
      actor: { userId: "owner-1", name: "Owner" },
      userId: "member-1",
      capability: "rundown-operator",
      duration: "this-week",
      reason: "",
      database,
    })).rejects.toThrow("already has Rundown operator access");
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it("prevents an on-duty TM from revoking an ongoing owner grant", async () => {
    mocks.resolveAuthority.mockResolvedValue(dutyAuthority);
    mocks.grantFindFirst.mockResolvedValue({
      id: "grant-ongoing",
      userId: "member-1",
      capability: "device-operator",
      startsOn: "2026-08-01",
      expiresOn: null,
    });
    await expect(revokeMemberAccessForActor({
      orgId: "org-1",
      actor: { userId: "tm-1", name: "Duty TM" },
      grantId: "grant-ongoing",
      database,
    })).rejects.toThrow("current duty week");
    expect(mocks.databaseRun).not.toHaveBeenCalled();
  });

  it("does not notify twice when concurrent revocation already won", async () => {
    mocks.grantFindFirst.mockResolvedValue({
      id: "grant-weekly",
      userId: "member-1",
      capability: "rundown-operator",
      startsOn: "2026-08-23",
      expiresOn: "2026-08-30",
    });
    mocks.databaseRun.mockResolvedValue({ success: true, meta: { changes: 0 } });
    await expect(revokeMemberAccessForActor({
      orgId: "org-1",
      actor: { userId: "owner-1", name: "Owner" },
      grantId: "grant-weekly",
      database,
    })).rejects.toThrow("no longer active");
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });
});
