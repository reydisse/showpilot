import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiStatement,
} from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
  snapshot: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthority: vi.fn(),
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../access-grants", () => ({
  getAccessManagementSnapshotForActor: mocks.snapshot,
  grantMemberAccessForActor: mocks.grant,
  revokeMemberAccessForActor: mocks.revoke,
}));

function fakeDatabase(): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
          return (params[0] === "org-1" ? { id: "org-1" } : null) as T | null;
        }
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined), { DB: db });
  if (!response) throw new Error("Mobile API did not handle team access route");
  return response;
}

const authority = {
  canManage: true,
  kind: "permanent" as const,
  weekStart: "2026-08-23",
  weekEndExclusive: "2026-08-30",
  today: "2026-08-27",
};

describe("mobile team access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "owner-1", name: "Mobile Owner", email: "owner@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "owner",
      permissions: ["settings:members"],
    });
    mocks.snapshot.mockResolvedValue({
      authority,
      currentUserId: "owner-1",
      members: [{
        userId: "member-1",
        role: "sm",
        user: { name: "Stage Lead", email: "stage@example.com", image: null },
      }],
      grants: [],
    });
    mocks.grant.mockResolvedValue({ id: "grant-1" });
    mocks.revoke.mockResolvedValue({ ok: true });
  });

  it("returns the shared authority snapshot and capability catalog", async () => {
    const db = fakeDatabase();
    const response = await mobileRequest(db, "/api/mobile/v1/team/access?orgId=org-1");
    expect(response.status).toBe(200);
    const body = await response.json() as { capabilities: Array<{ id: string }>; members: Array<{ userId: string }> };
    expect(body.members).toEqual([expect.objectContaining({ userId: "member-1" })]);
    expect(body.capabilities.map((item) => item.id)).toContain("rundown-operator");
    expect(mocks.snapshot).toHaveBeenCalledWith({
      orgId: "org-1",
      actorUserId: "owner-1",
      database: db,
    });
  });

  it("passes a validated grant command to the same service used by web", async () => {
    const db = fakeDatabase();
    const response = await mobileRequest(
      db,
      "/api/mobile/v1/team/access/grants?orgId=org-1",
      {
        userId: "member-1",
        capability: "rundown-operator",
        duration: "this-week",
        reason: "Covering Sunday",
      },
    );
    expect(response.status).toBe(201);
    expect(mocks.grant).toHaveBeenCalledWith({
      orgId: "org-1",
      actor: { userId: "owner-1", name: "Mobile Owner" },
      userId: "member-1",
      capability: "rundown-operator",
      duration: "this-week",
      reason: "Covering Sunday",
      database: db,
    });
  });

  it("rejects invented capabilities at the transport boundary", async () => {
    const response = await mobileRequest(
      fakeDatabase(),
      "/api/mobile/v1/team/access/grants?orgId=org-1",
      { userId: "member-1", capability: "become-owner", duration: "until-revoked" },
    );
    expect(response.status).toBe(400);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("routes revocation through the shared service with tenant and actor scope", async () => {
    const db = fakeDatabase();
    const response = await mobileRequest(
      db,
      "/api/mobile/v1/team/access/grants/grant-1/revoke?orgId=org-1",
      {},
    );
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith({
      orgId: "org-1",
      actor: { userId: "owner-1", name: "Mobile Owner" },
      grantId: "grant-1",
      database: db,
    });
  });

  it("does not expose the snapshot without organization membership", async () => {
    mocks.resolveAccess.mockResolvedValue(null);
    const response = await mobileRequest(fakeDatabase(), "/api/mobile/v1/team/access?orgId=org-1");
    expect(response.status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
