import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notifyOperationalEvent: vi.fn(),
  resolveAccess: vi.fn(),
  resolveAuthorityForAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: mocks.resolveAuthorityForAccess,
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

interface NotificationFixture {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  actionUrl: string;
  source: string;
  createdAt: string;
  readAt: string | null;
}

interface StatementCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: {
  assignment?: AssignmentFixture;
  calls?: StatementCall[];
  scheduleAssignments?: ScheduleAssignmentFixture[];
  notifications?: NotificationFixture[];
  unreadNotifications?: number;
  timeZone?: string;
  updateChanges?: number;
} = {}): MobileApiDatabase {
  return {
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          input.calls?.push({ sql, params });
          return {
            async first<T>() {
              if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
              if (sql.startsWith("SELECT id, name, slug FROM organization")) {
                return { id: "org-1", name: "Test Organization", slug: "test-org" } as T;
              }
              if (sql.includes("key = 'org-timezone'")) {
                return { value: input.timeZone ?? "Africa/Accra" } as T;
              }
              if (sql.includes("CAST(COUNT(*) AS INTEGER) AS count") && sql.includes("FROM notification")) {
                return { count: input.unreadNotifications ?? 0 } as T;
              }
              if (sql.includes("FROM service_assignment a")) return (input.assignment ?? null) as T | null;
              return null;
            },
            async all<T>() {
              if (sql.startsWith("SELECT key, value FROM app_setting")) {
                return {
                  results: [
                    { key: "org-timezone", value: input.timeZone ?? "Africa/Accra" },
                    { key: "default-service-window-minutes", value: "120" },
                  ] as T[],
                };
              }
              if (sql.includes("FROM service_assignment a")) {
                return { results: (input.scheduleAssignments ?? []) as T[] };
              }
              if (sql.includes("FROM notification")) {
                return { results: (input.notifications ?? []) as T[] };
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
    mocks.resolveAuthorityForAccess.mockResolvedValue({
      canManage: false,
      kind: "none",
      weekStart: "2026-08-23",
      weekEndExclusive: "2026-08-30",
      today: "2026-08-27",
    });
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
      timeZone: "Africa/Accra",
      assignments: [{
        id: "assignment-1",
        canRespond: false,
        responseWindow: { status: "closed" },
      }],
    });
  });

  it("opens a notified assignment outside the default schedule range", async () => {
    const calls: StatementCall[] = [];
    const serviceDate = "2028-12-24";
    const response = await handleMobileApi(
      new Request(
        "https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1&assignment=assignment-1",
      ),
      {
        DB: fakeDatabase({
          assignment: assignment({ serviceDate }),
          calls,
        }),
      },
    );
    if (!response) throw new Error("Mobile API did not handle the schedule route");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      from: serviceDate,
      to: serviceDate,
    });
    const serviceQuery = calls.find((call) => call.sql.includes("FROM rundown r"));
    expect(serviceQuery?.params.slice(1, 3)).toEqual([serviceDate, serviceDate]);
    const selectionQuery = calls.find(
      (call) => call.sql.includes("SELECT a.serviceDate"),
    );
    expect(selectionQuery?.sql).toContain("(? = 1 OR LOWER(c.email) = ?)");
    expect(selectionQuery?.params).toEqual([
      "org-1",
      "assignment-1",
      0,
      "test@example.com",
    ]);
  });

  it("keeps an exact notification selection outside caller-supplied ranges", async () => {
    const calls: StatementCall[] = [];
    const serviceDate = "2028-12-24";
    const response = await handleMobileApi(
      new Request(
        "https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1&date=2028-12-24&from=2026-01-01&to=2026-01-02",
      ),
      { DB: fakeDatabase({ calls }) },
    );
    if (!response) throw new Error("Mobile API did not handle the schedule route");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      from: serviceDate,
      to: serviceDate,
    });
    const serviceQuery = calls.find((call) => call.sql.includes("FROM rundown r"));
    expect(serviceQuery?.params.slice(1, 3)).toEqual([serviceDate, serviceDate]);
  });

  it("returns the venue timezone in the native bootstrap payload", async () => {
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/bootstrap?orgId=org-1"),
      { DB: fakeDatabase({ timeZone: "America/New_York" }) },
    );
    if (!response) throw new Error("Mobile API did not handle the bootstrap route");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organization: { id: "org-1", slug: "test-org" },
      timeZone: "America/New_York",
    });
  });

  it("returns the complete unread count independently of the notification page", async () => {
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/bootstrap?orgId=org-1"),
      {
        DB: fakeDatabase({
          notifications: [{
            id: "notification-1",
            type: "assignment",
            severity: "info",
            title: "New assignment",
            message: "Camera 1",
            actionUrl: "schedule",
            source: "schedule",
            createdAt: "2026-08-26T00:00:00.000Z",
            readAt: null,
          }],
          unreadNotifications: 74,
        }),
      },
    );
    if (!response) throw new Error("Mobile API did not handle the bootstrap route");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notifications: [{ id: "notification-1" }],
      unreadNotifications: 74,
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

  it("rejects malformed exact schedule selections at the API boundary", async () => {
    const invalidDate = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1&date=2026-02-31"),
      { DB: fakeDatabase() },
    );
    const invalidAssignment = await handleMobileApi(
      new Request(`https://showpilot.tech/api/mobile/v1/schedule?orgId=org-1&assignment=${"a".repeat(129)}`),
      { DB: fakeDatabase() },
    );

    expect(invalidDate?.status).toBe(400);
    expect(invalidAssignment?.status).toBe(400);
  });
});
