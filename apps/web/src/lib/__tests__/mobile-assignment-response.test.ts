import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notifyOperationalEvent: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: mocks.notifyOperationalEvent,
}));

interface AssignmentFixture {
  id: string;
  showId: string | null;
  crewMemberId: string;
  role: string;
  serviceDate: string;
  status: string;
  crewName: string;
  crewEmail: string;
  scheduledStartTime: string | null;
  plannedDurationMs: number;
}

interface ScheduleAssignmentFixture extends AssignmentFixture {
  department: string;
  callTime: string;
  notes: string;
  responseNote: string;
}

interface StatementCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: {
  assignment?: AssignmentFixture;
  calls?: StatementCall[];
  scheduleAssignments?: ScheduleAssignmentFixture[];
  updateChanges?: number;
} = {}): MobileApiDatabase {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          input.calls?.push({ sql, params });
          return {
            async first<T>() {
              if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
              if (sql.includes("FROM service_assignment a")) return (input.assignment ?? null) as T | null;
              return null;
            },
            async all<T>() {
              if (sql.startsWith("SELECT key, value FROM app_setting")) {
                return {
                  results: [
                    { key: "org-timezone", value: "Africa/Accra" },
                    { key: "default-service-window-minutes", value: "120" },
                  ] as T[],
                };
              }
              if (sql.includes("FROM service_assignment a")) {
                return { results: (input.scheduleAssignments ?? []) as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              return {
                success: true,
                meta: { changes: input.updateChanges ?? 1 },
              };
            },
          };
        },
      };
    },
  };
}

function futureDate(days = 7): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function assignment(overrides: Partial<AssignmentFixture> = {}): AssignmentFixture {
  return {
    id: "assignment-1",
    showId: null,
    crewMemberId: "crew-1",
    role: "Stage manager",
    serviceDate: futureDate(),
    status: "assigned",
    crewName: "Test Person",
    crewEmail: "test@example.com",
    scheduledStartTime: null,
    plannedDurationMs: 0,
    ...overrides,
  };
}

async function respond(db: MobileApiDatabase) {
  const response = await handleMobileApi(
    new Request("https://showpilot.tech/api/mobile/v1/schedule/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId: "org-1",
        assignmentId: "assignment-1",
        response: "confirmed",
      }),
    }),
    { DB: db },
  );
  if (!response) throw new Error("Mobile API did not handle the response route");
  return response;
}

describe("mobile assignment responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Test Person", email: "test@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [] });
    mocks.notifyOperationalEvent.mockResolvedValue(undefined);
  });

  it("rejects an unanswered assignment after its service date has ended", async () => {
    const calls: StatementCall[] = [];
    const response = await respond(fakeDatabase({
      assignment: assignment({ serviceDate: "2020-01-01" }),
      calls,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This assignment is closed because the service has ended.",
    });
    expect(calls.some((call) => call.sql.startsWith("UPDATE service_assignment"))).toBe(false);
    expect(mocks.notifyOperationalEvent).not.toHaveBeenCalled();
  });

  it("rejects an assignment that already has a response", async () => {
    const response = await respond(fakeDatabase({ assignment: assignment({ status: "confirmed" }) }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "A response has already been recorded for this assignment.",
    });
    expect(mocks.notifyOperationalEvent).not.toHaveBeenCalled();
  });

  it("uses an atomic assigned-state update to stop concurrent responses", async () => {
    const calls: StatementCall[] = [];
    const response = await respond(fakeDatabase({ assignment: assignment(), calls, updateChanges: 0 }));

    expect(response.status).toBe(409);
    const update = calls.find((call) => call.sql.startsWith("UPDATE service_assignment"));
    expect(update?.sql).toContain("crewMemberId = ? AND status = 'assigned'");
    expect(mocks.notifyOperationalEvent).not.toHaveBeenCalled();
  });

  it("records one open response and notifies leadership", async () => {
    const response = await respond(fakeDatabase({ assignment: assignment(), updateChanges: 1 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.notifyOperationalEvent).toHaveBeenCalledOnce();
  });

  it("does not expose another crew member's assignment", async () => {
    const response = await respond(fakeDatabase({
      assignment: assignment({ crewEmail: "someone-else@example.com" }),
    }));

    expect(response.status).toBe(404);
    expect(mocks.notifyOperationalEvent).not.toHaveBeenCalled();
  });

  it("marks an ended assignment as closed in the schedule payload", async () => {
    const startedAt = new Date(Date.now() - 3 * 3_600_000);
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1"),
      {
        DB: fakeDatabase({
          scheduleAssignments: [{
            ...assignment({
              showId: "show-1",
              serviceDate: startedAt.toISOString().slice(0, 10),
              scheduledStartTime: startedAt.toISOString(),
              plannedDurationMs: 3_600_000,
            }),
            department: "Production",
            callTime: "",
            notes: "",
            responseNote: "",
          }],
        }),
      },
    );
    if (!response) throw new Error("Mobile API did not handle the schedule route");

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      assignments: [{
        id: "assignment-1",
        canRespond: false,
        responseWindow: { status: "closed" },
      }],
    });
  });
});

describe("mobile API boundary parsing", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Test Person", email: "test@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [] });
  });

  it("returns a clean 404 for malformed encoded route IDs", async () => {
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/rundowns/%E0%A4%A?orgId=org-1"),
      { DB: fakeDatabase() },
    );

    expect(response?.status).toBe(404);
  });

  it("rejects calendar dates that only match the date regex", async () => {
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1&from=2026-02-31&to=2026-03-02"),
      { DB: fakeDatabase() },
    );

    expect(response?.status).toBe(400);
  });
});
