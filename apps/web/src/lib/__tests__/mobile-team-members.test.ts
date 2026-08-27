import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
  checkPlanLimit: vi.fn(),
  createInvitation: vi.fn(),
  cancelInvitation: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({
    api: {
      getSession: mocks.getSession,
      createInvitation: mocks.createInvitation,
      cancelInvitation: mocks.cancelInvitation,
      updateMemberRole: mocks.updateMemberRole,
      removeMember: mocks.removeMember,
    },
  }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../plan-limits", () => ({
  PlanLimitError: class PlanLimitError extends Error { status = 402; },
  checkPlanLimit: mocks.checkPlanLimit,
}));

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: {
  calls?: QueryCall[];
  scopedMember?: boolean;
  scopedInvitation?: boolean;
} = {}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
          return (params[0] === "org-1" ? { id: "org-1" } : null) as T | null;
        }
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        if (sql.includes("COUNT(*)") && sql.includes("FROM member")) return { count: 2 } as T;
        if (sql.includes("COUNT(*)") && sql.includes("FROM invitation")) return { count: 1 } as T;
        if (sql.startsWith("SELECT id FROM member WHERE id = ?")) {
          return (input.scopedMember === false ? null : { id: params[0] }) as T | null;
        }
        if (sql.startsWith("SELECT id FROM invitation WHERE id = ?")) {
          return (input.scopedInvitation === false ? null : { id: params[0] }) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM member m")) {
          return { results: [{
            id: "membership-1",
            userId: "member-1",
            organizationId: "org-1",
            role: "sm",
            createdAt: "2026-08-01T00:00:00.000Z",
            userName: "Stage Lead",
            userEmail: "stage@example.com",
            userImage: null,
          }] as T[] };
        }
        if (sql.includes("FROM invitation")) {
          return { results: [{
            id: "invite-1",
            email: "new@example.com",
            role: "member",
            status: "pending",
            expiresAt: "2026-08-29T00:00:00.000Z",
            createdAt: "2026-08-27T00:00:00.000Z",
          }] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      return Promise.all(statements.map((item) => item.run()));
    },
  };
}

async function mobileRequest(db: MobileApiDatabase, path: string, body?: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=test" },
    body: JSON.stringify(body),
  } : { headers: { Cookie: "session=test" } }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle team membership route");
  return response;
}

describe("mobile team membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "owner-1", name: "Mobile Owner", email: "owner@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "owner",
      permissions: ["settings:members"],
      today: "2026-08-27",
    });
    mocks.checkPlanLimit.mockResolvedValue(undefined);
    mocks.createInvitation.mockResolvedValue({
      id: "invite-2",
      email: "new@example.com",
      role: "tm",
      status: "pending",
      expiresAt: "2026-08-29T00:00:00.000Z",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    mocks.cancelInvitation.mockResolvedValue({});
    mocks.updateMemberRole.mockResolvedValue({ id: "membership-1", role: "tm" });
    mocks.removeMember.mockResolvedValue({});
  });

  it("lists only explicitly scoped memberships and pending invitations", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(fakeDatabase({ calls }), "/api/mobile/v1/team/members?orgId=org-1");
    expect(response.status).toBe(200);
    const body = await response.json() as { members: Array<{ organizationId: string }>; invitations: Array<{ id: string }> };
    expect(body.members).toEqual([expect.objectContaining({ organizationId: "org-1" })]);
    expect(body.invitations).toEqual([expect.objectContaining({ id: "invite-1" })]);
    expect(calls
      .filter((call) => call.sql.includes("FROM member m") || call.sql.includes("FROM invitation"))
      .every((call) => call.params.includes("org-1")))
      .toBe(true);
  });

  it("checks the combined plan count and creates an invitation for the requested organization", async () => {
    const response = await mobileRequest(
      fakeDatabase(),
      "/api/mobile/v1/team/invitations?orgId=org-1",
      { email: "NEW@example.com", role: "tm" },
    );
    expect(response.status).toBe(201);
    expect(mocks.checkPlanLimit).toHaveBeenCalledWith("org-1", "members", 3);
    expect(mocks.createInvitation).toHaveBeenCalledWith(expect.objectContaining({
      body: { email: "new@example.com", role: "tm", organizationId: "org-1" },
    }));
  });

  it("rejects a role update when the membership is outside the organization", async () => {
    const response = await mobileRequest(
      fakeDatabase({ scopedMember: false }),
      "/api/mobile/v1/team/members/foreign-member/role?orgId=org-1",
      { role: "tm" },
    );
    expect(response.status).toBe(404);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("updates a scoped member with an explicit organization id", async () => {
    const response = await mobileRequest(
      fakeDatabase(),
      "/api/mobile/v1/team/members/membership-1/role?orgId=org-1",
      { role: "sm" },
    );
    expect(response.status).toBe(200);
    expect(mocks.updateMemberRole).toHaveBeenCalledWith(expect.objectContaining({
      body: { memberId: "membership-1", role: "sm", organizationId: "org-1" },
    }));
  });

  it("does not cancel an invitation outside the requested organization", async () => {
    const response = await mobileRequest(
      fakeDatabase({ scopedInvitation: false }),
      "/api/mobile/v1/team/invitations/foreign-invite/cancel?orgId=org-1",
      {},
    );
    expect(response.status).toBe(404);
    expect(mocks.cancelInvitation).not.toHaveBeenCalled();
  });

  it("removes a scoped membership with an explicit organization id", async () => {
    const response = await mobileRequest(
      fakeDatabase(),
      "/api/mobile/v1/team/members/membership-1/remove?orgId=org-1",
      {},
    );
    expect(response.status).toBe(200);
    expect(mocks.removeMember).toHaveBeenCalledWith(expect.objectContaining({
      body: { memberIdOrEmail: "membership-1", organizationId: "org-1" },
    }));
  });

  it("requires member-management permission for every membership surface", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [], today: "2026-08-27" });
    const response = await mobileRequest(fakeDatabase(), "/api/mobile/v1/team/members?orgId=org-1");
    expect(response.status).toBe(403);
  });
});
