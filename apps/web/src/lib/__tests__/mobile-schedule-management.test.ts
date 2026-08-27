import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  clearInvitation: vi.fn(),
  deleteService: vi.fn(),
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
  sendInvite: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../crew-schedule", () => ({ sendCrewScheduleInvite: mocks.sendInvite }));
vi.mock("../assignment-notifications.server", () => ({ clearAssignmentInvitation: mocks.clearInvitation }));
vi.mock("../service-deletion.server", () => ({ deleteServiceForOrg: mocks.deleteService }));

interface QueryCall {
  sql: string;
  params: unknown[];
  operation: "first" | "all" | "run";
}

interface AssignmentRow {
  id: string;
  orgId: string;
  showId: string;
  serviceDate: string;
  crewMemberId: string | null;
  role: string;
  department: string;
  status: string;
  callTime: string;
  notes: string;
  responseNote: string;
  invitedAt: string | null;
  respondedAt: string | null;
  updatedAt: string;
}

function fakeDatabase(input: {
  assignment?: AssignmentRow | null;
  calls?: QueryCall[];
  crewEmail?: string;
  changes?: number;
} = {}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        input.calls?.push({ sql, params, operation: "first" });
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT id, serviceDate, status, updatedAt FROM rundown")) {
          return { id: "show-1", serviceDate: "2026-09-06", status: "stopped", updatedAt: "show-version-1" } as T;
        }
        if (sql.startsWith("SELECT id, name, email FROM crew_member")) {
          return { id: "crew-1", name: "Ada", email: input.crewEmail ?? "ada@example.com" } as T;
        }
        if (sql.includes("FROM service_assignment WHERE id = ?")) return (input.assignment ?? null) as T | null;
        if (sql.startsWith("SELECT value FROM app_setting")) return { value: "Africa/Accra" } as T;
        return null;
      },
      async all<T>() {
        input.calls?.push({ sql, params, operation: "all" });
        if (sql.includes("FROM service_assignment") && input.assignment) return { results: [input.assignment] as T[] };
        return { results: [] as T[] };
      },
      async run() {
        input.calls?.push({ sql, params, operation: "run" });
        return { success: true, meta: { changes: input.changes ?? 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

async function post(db: MobileApiDatabase, path: string, body: Record<string, unknown> = {}) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle schedule route");
  return response;
}

const assignmentInput = {
  requestId: "mobile-assignment-1",
  showId: "show-1",
  role: "Camera 1",
  department: "Video",
  crewMemberId: "crew-1",
  callTime: "08:15",
  notes: "Use stage-left camera",
  expectedUpdatedAt: null,
};

function assignment(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: "assignment-1",
    orgId: "org-1",
    showId: "show-1",
    serviceDate: "2026-09-06",
    crewMemberId: "crew-old",
    role: "Camera 1",
    department: "Video",
    status: "assigned",
    callTime: "08:00",
    notes: "",
    responseNote: "",
    invitedAt: null,
    respondedAt: null,
    updatedAt: "assignment-version-1",
    ...overrides,
  };
}

describe("mobile schedule management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "manager-1", name: "Manager", email: "manager@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["schedule:manage"], today: "2026-08-27" });
    mocks.sendInvite.mockResolvedValue({ delivered: true, reason: null });
    mocks.deleteService.mockResolvedValue({ ok: true });
  });

  it("creates one retry-safe, tenant-owned assignment and delivers its invitation", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/schedule/assignments?orgId=org-1", assignmentInput);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true, id: "mobile-assignment-1", created: true, delivered: true });
    const insert = calls.find((call) => call.sql.startsWith("INSERT INTO service_assignment"));
    expect(insert?.params).toEqual([
      "mobile-assignment-1", "org-1", "show-1", "2026-09-06", "crew-1",
      "Camera 1", "Video", "08:15", "Use stage-left camera",
    ]);
    expect(mocks.sendInvite).toHaveBeenCalledTimes(1);
  });

  it("returns an identical repeated create without writing or notifying twice", async () => {
    const calls: QueryCall[] = [];
    const existing = assignment({
      id: "mobile-assignment-1",
      crewMemberId: "crew-1",
      callTime: "08:15",
      notes: "Use stage-left camera",
      invitedAt: "2026-08-27 10:00:00",
    });
    const response = await post(fakeDatabase({ calls, assignment: existing }), "/api/mobile/v1/schedule/assignments?orgId=org-1", assignmentInput);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, id: "mobile-assignment-1", created: false, delivered: true });
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO service_assignment"))).toBe(false);
    expect(mocks.sendInvite).not.toHaveBeenCalled();
  });

  it("rejects a stale concurrent assignment edit before changing or notifying", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls, assignment: assignment() }), "/api/mobile/v1/schedule/assignments/assignment-1?orgId=org-1", {
      ...assignmentInput,
      expectedUpdatedAt: "stale-version",
    });
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.sql.startsWith("UPDATE service_assignment\n     SET role"))).toBe(false);
    expect(mocks.sendInvite).not.toHaveBeenCalled();
  });

  it("reassigns atomically, clears the old invitation, and sends the replacement", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls, assignment: assignment() }), "/api/mobile/v1/schedule/assignments/assignment-1?orgId=org-1", {
      ...assignmentInput,
      expectedUpdatedAt: "assignment-version-1",
    });
    expect(response.status).toBe(200);
    expect(mocks.clearInvitation).toHaveBeenCalledWith("org-1", "assignment-1");
    expect(mocks.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "assignment-1", crewMemberId: "crew-1" }));
    const update = calls.find((call) => call.sql.startsWith("UPDATE service_assignment\n     SET role"));
    expect(update?.params.slice(-4)).toEqual(["assignment-1", "org-1", "show-1", "assignment-version-1"]);
  });

  it("deletes an assignment and its notifications inside the organization", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/schedule/assignments/assignment-1/remove?orgId=org-1");
    expect(response.status).toBe(200);
    expect(calls.filter((call) => call.operation === "run").map((call) => call.params)).toContainEqual(["org-1", "assignment-1"]);
  });

  it("updates service details only at the version the manager viewed", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/schedule/services/show-1?orgId=org-1", {
      name: "Sunday Morning",
      startTime: "09:30",
      location: "Main room",
      expectedUpdatedAt: "show-version-1",
    });
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.startsWith("UPDATE rundown SET name"));
    expect(update?.params).toEqual([
      "Sunday Morning", "2026-09-06T09:30:00.000Z", "Main room", "show-1", "org-1", "show-version-1",
    ]);
  });

  it("delegates complete service deletion after tenant authorization", async () => {
    const response = await post(fakeDatabase(), "/api/mobile/v1/schedule/services/show-1/remove?orgId=org-1");
    expect(response.status).toBe(200);
    expect(mocks.deleteService).toHaveBeenCalledWith({ orgId: "org-1", showId: "show-1" });
  });

  it("rejects insecure external provider URLs before persisting settings", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/schedule/provider?orgId=org-1", {
      provider: "other",
      url: "http://planner.example.com",
      label: "Planner",
      terminologyProfile: "general",
    });
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO app_setting"))).toBe(false);
  });
});
