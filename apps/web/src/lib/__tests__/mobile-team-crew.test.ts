import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: { calls?: QueryCall[]; changes?: number } = {}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM crew_member")) {
          return { results: [{
            id: "crew-1",
            memberId: "TD3917",
            name: "Ada Operator",
            role: "Technical Director",
            email: "ada@example.com",
            photoUrl: "",
            isOnline: 1,
            lastCheckIn: "2026-08-27T08:00:00.000Z",
            lastCheckOut: null,
          }] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: input.changes ?? 1 } };
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
  if (!response) throw new Error("Mobile API did not handle team crew route");
  return response;
}

const crewWrite = {
  memberId: " td3917 ",
  name: " Ada Operator ",
  role: " Technical Director ",
  email: " ADA@EXAMPLE.COM ",
  photoUrl: "",
};

describe("mobile team crew roster", () => {
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
  });

  it("lists the organization-scoped roster and serializes check-in state", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(fakeDatabase({ calls }), "/api/mobile/v1/team/crew?orgId=org-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      members: [expect.objectContaining({ id: "crew-1", email: "ada@example.com", isOnline: true })],
    });
    expect(calls.find((call) => call.sql.includes("FROM crew_member"))?.params).toEqual(["org-1"]);
  });

  it("normalizes a valid crew record and inserts it with explicit tenant scope", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(fakeDatabase({ calls }), "/api/mobile/v1/team/crew?orgId=org-1", crewWrite);
    expect(response.status).toBe(201);
    const insert = calls.find((call) => call.sql.startsWith("INSERT INTO crew_member"));
    expect(insert?.params.slice(1)).toEqual([
      "org-1",
      "TD3917",
      "Ada Operator",
      "Technical Director",
      "ada@example.com",
      "",
    ]);
  });

  it("rejects malformed or oversized photo payloads before writing", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(
      fakeDatabase({ calls }),
      "/api/mobile/v1/team/crew?orgId=org-1",
      { ...crewWrite, photoUrl: "data:text/html;base64,PHNjcmlwdD4=" },
    );
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO crew_member"))).toBe(false);
  });

  it("uses the crew id and organization together for updates", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(
      fakeDatabase({ calls }),
      "/api/mobile/v1/team/crew/crew-1/update?orgId=org-1",
      crewWrite,
    );
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.sql.startsWith("UPDATE crew_member"))?.params.slice(-2))
      .toEqual(["crew-1", "org-1"]);
  });

  it("returns not found when an update cannot change a tenant-scoped row", async () => {
    const response = await mobileRequest(
      fakeDatabase({ changes: 0 }),
      "/api/mobile/v1/team/crew/foreign-crew/update?orgId=org-1",
      crewWrite,
    );
    expect(response.status).toBe(404);
  });

  it("deletes only by crew id and organization id", async () => {
    const calls: QueryCall[] = [];
    const response = await mobileRequest(
      fakeDatabase({ calls }),
      "/api/mobile/v1/team/crew/crew-1/remove?orgId=org-1",
      {},
    );
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.sql.startsWith("DELETE FROM crew_member"))?.params)
      .toEqual(["crew-1", "org-1"]);
  });

  it("requires permanent member-management permission", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "tm", permissions: ["checkin:access"], today: "2026-08-27" });
    const response = await mobileRequest(fakeDatabase(), "/api/mobile/v1/team/crew?orgId=org-1");
    expect(response.status).toBe(403);
  });
});
