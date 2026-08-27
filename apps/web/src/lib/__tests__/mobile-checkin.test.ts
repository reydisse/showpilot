import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiStatement,
} from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

interface CrewFixture {
  id: string;
  orgId: string;
  memberId: string;
  name: string;
  role: string;
  photoUrl: string;
  isOnline: boolean;
  lastCheckIn: string | null;
  lastCheckOut: string | null;
}

function createMembers(): CrewFixture[] {
  return [
    {
      id: "crew-1",
      orgId: "org-1",
      memberId: "TD3917",
      name: "Ada Director",
      role: "Technical Director",
      photoUrl: "",
      isOnline: false,
      lastCheckIn: null,
      lastCheckOut: null,
    },
    {
      id: "crew-other",
      orgId: "org-2",
      memberId: "CAM404",
      name: "Other Tenant",
      role: "Camera",
      photoUrl: "",
      isOnline: true,
      lastCheckIn: "2026-08-27T08:00:00.000Z",
      lastCheckOut: null,
    },
  ];
}

function fakeDatabase(members: CrewFixture[]): MobileApiDatabase {
  function selectMember(member: CrewFixture) {
    return {
      id: member.id,
      memberId: member.memberId,
      name: member.name,
      role: member.role,
      photoUrl: member.photoUrl,
      isOnline: member.isOnline ? 1 : 0,
      lastCheckIn: member.lastCheckIn,
      lastCheckOut: member.lastCheckOut,
    };
  }

  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
          return (params[0] === "org-1" ? { id: "org-1" } : null) as T | null;
        }
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        if (sql.includes("key = 'clock-format'")) return { value: "24hr" } as T;
        if (sql.includes("key = 'org-timezone'")) return { value: "Africa/Accra" } as T;
        if (sql.includes("FROM crew_member WHERE id = ? AND orgId = ?")) {
          const member = members.find((candidate) => candidate.id === params[0] && candidate.orgId === params[1]);
          return (member ? selectMember(member) : null) as T | null;
        }
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("FROM crew_member WHERE orgId = ?")) {
          const results = members
            .filter((member) => member.orgId === params[0])
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(selectMember);
          return { results: results as T[] };
        }
        throw new Error(`Unhandled all query: ${sql}`);
      },
      async run() {
        if (sql.startsWith("UPDATE crew_member")) {
          const [online, , , memberId, orgId] = params as [number, number, number, string, string];
          const member = members.find((candidate) => candidate.id === memberId && candidate.orgId === orgId);
          if (!member) return { success: true, meta: { changes: 0 } };
          const nextOnline = Boolean(online);
          if (nextOnline !== member.isOnline) {
            if (nextOnline) member.lastCheckIn = "2026-08-27 12:00:00";
            else member.lastCheckOut = "2026-08-27 12:00:00";
          }
          member.isOnline = nextOnline;
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error(`Unhandled run query: ${sql}`);
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
  if (!response) throw new Error("Mobile API did not handle check-in route");
  return response;
}

describe("mobile check-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Mobile Producer", email: "producer@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "stage-manager",
      permissions: ["checkin:access"],
    });
  });

  it("returns only the authorized organization's crew", async () => {
    const response = await mobileRequest(fakeDatabase(createMembers()), "/api/mobile/v1/checkin?orgId=org-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: [{
        id: "crew-1",
        memberId: "TD3917",
        name: "Ada Director",
        role: "Technical Director",
        photoUrl: "",
        isOnline: false,
        lastCheckIn: null,
        lastCheckOut: null,
      }],
    });
  });

  it("sets status explicitly and stays checked in when the same request is retried", async () => {
    const members = createMembers();
    const db = fakeDatabase(members);
    const path = "/api/mobile/v1/checkin/members/crew-1/status?orgId=org-1";
    const first = await mobileRequest(db, path, { checkedIn: true });
    const retry = await mobileRequest(db, path, { checkedIn: true });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(members[0].isOnline).toBe(true);
    expect(members[0].lastCheckIn).toBe("2026-08-27 12:00:00");
    expect(members[0].lastCheckOut).toBeNull();
  });

  it("does not update a member from another tenant", async () => {
    const response = await mobileRequest(
      fakeDatabase(createMembers()),
      "/api/mobile/v1/checkin/members/crew-other/status?orgId=org-1",
      { checkedIn: false },
    );
    expect(response.status).toBe(404);
  });

  it("requires an explicit target status", async () => {
    const response = await mobileRequest(
      fakeDatabase(createMembers()),
      "/api/mobile/v1/checkin/members/crew-1/status?orgId=org-1",
      {},
    );
    expect(response.status).toBe(400);
  });

  it("rejects users without check-in access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "viewer", permissions: ["show:view"] });
    const response = await mobileRequest(fakeDatabase(createMembers()), "/api/mobile/v1/checkin?orgId=org-1");
    expect(response.status).toBe(403);
  });

  it("returns a tenant-scoped Show Board to users with Show Board access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "viewer", permissions: ["showboard:view"] });

    const response = await mobileRequest(fakeDatabase(createMembers()), "/api/mobile/v1/show-board?orgId=org-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clockFormat: "24hr",
      timeZone: "Africa/Accra",
      members: [{
        id: "crew-1",
        memberId: "TD3917",
        name: "Ada Director",
        role: "Technical Director",
        photoUrl: "",
        isOnline: false,
        lastCheckIn: null,
        lastCheckOut: null,
      }],
    });
  });

  it("does not treat check-in access as Show Board access", async () => {
    const response = await mobileRequest(fakeDatabase(createMembers()), "/api/mobile/v1/show-board?orgId=org-1");
    expect(response.status).toBe(403);
  });
});
