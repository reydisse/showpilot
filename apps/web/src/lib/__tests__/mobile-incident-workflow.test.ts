import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notify: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: mocks.notify,
}));

interface IncidentFixture {
  id: string;
  status: string;
  assignedTo: string | null;
  acknowledgedAt: string | null;
}

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface ResponderFixture {
  userId: string;
  role: string;
  name: string;
}

interface GrantFixture {
  userId: string;
  permissions: string;
}

function fakeDatabase(input: {
  calls?: QueryCall[];
  incident?: IncidentFixture | null;
  changes?: number;
  responders?: ResponderFixture[];
  grants?: GrantFixture[];
} = {}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        if (sql.startsWith("SELECT id, status, assignedTo")) {
          return (input.incident === undefined
            ? { id: "incident-1", status: "open", assignedTo: null, acknowledgedAt: null }
            : input.incident) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM member m JOIN user u")) {
          return { results: (input.responders ?? []) as T[] };
        }
        if (sql.includes("FROM access_grant")) {
          return { results: (input.grants ?? []) as T[] };
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

async function post(db: MobileApiDatabase, path: string, body: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle incident route");
  return response;
}

describe("mobile incident workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "operator-1", name: "Ada Operator", email: "ada@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "tm",
      permissions: ["incidents:access"],
      today: "2026-08-27",
    });
    mocks.notify.mockResolvedValue(undefined);
  });

  it("claims an open unassigned incident with one tenant-scoped conditional update", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "claim" },
    );
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.includes("SET assignedTo"));
    expect(update?.sql).toContain("status <> 'resolved'");
    expect(update?.sql).toContain("assignedTo IS NULL");
    expect(update?.params.slice(-3)).toEqual(["incident-1", "org-1", "operator-1"]);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("returns not found without writing when the incident is outside the organization", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls, incident: null }),
      "/api/mobile/v1/incidents/foreign-incident/command?orgId=org-1",
      { action: "resolve" },
    );
    expect(response.status).toBe(404);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
  });

  it("makes a repeated claim idempotent without sending another notification", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls, incident: { id: "incident-1", status: "open", assignedTo: "operator-1", acknowledgedAt: "2026-08-27T08:00:00.000Z" } }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "claim" },
    );
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("allows only the assigned operator to acknowledge", async () => {
    const response = await post(
      fakeDatabase({ incident: { id: "incident-1", status: "open", assignedTo: "operator-2", acknowledgedAt: null } }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "acknowledge" },
    );
    expect(response.status).toBe(403);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not acknowledge an incident after another operator resolves it", async () => {
    const response = await post(
      fakeDatabase({ incident: { id: "incident-1", status: "resolved", assignedTo: "operator-1", acknowledgedAt: null } }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "acknowledge" },
    );
    expect(response.status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("rejects a stale concurrent transition and does not notify", async () => {
    const response = await post(
      fakeDatabase({ changes: 0 }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "resolve" },
    );
    expect(response.status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("makes repeated resolution idempotent", async () => {
    const response = await post(
      fakeDatabase({ incident: { id: "incident-1", status: "resolved", assignedTo: "operator-1", acknowledgedAt: null } }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "resolve" },
    );
    expect(response.status).toBe(200);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("updates incident content with its organization in the write condition", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/update?orgId=org-1",
      { category: "audio", severity: "high", description: "FOH console stopped passing audio." },
    );
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.includes("SET category"));
    expect(update?.params.slice(-2)).toEqual(["incident-1", "org-1"]);
  });

  it("deletes an incident only by id and organization id", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/remove?orgId=org-1",
      {},
    );
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.sql.startsWith("DELETE FROM incident"))?.params)
      .toEqual(["incident-1", "org-1"]);
  });

  it("denies management commands to report-only roles", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["incidents:report"], today: "2026-08-27" });
    const response = await post(
      fakeDatabase(),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "claim" },
    );
    expect(response.status).toBe(403);
  });

  it("allows only the admin tier to assign another responder", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "assign", targetUserId: "operator-2" },
    );
    expect(response.status).toBe(403);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
  });

  it("rejects a responder who lacks effective access in the organization", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["incidents:access"], today: "2026-08-27" });
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({
        calls,
        responders: [{ userId: "operator-2", role: "member", name: "Sam Crew" }],
      }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "assign", targetUserId: "operator-2" },
    );
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("assigns a responder with an active temporary incident grant", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["incidents:access"], today: "2026-08-27" });
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({
        calls,
        responders: [{ userId: "operator-2", role: "member", name: "Sam Crew" }],
        grants: [{ userId: "operator-2", permissions: JSON.stringify(["incidents:access"]) }],
      }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "assign", targetUserId: "operator-2" },
    );
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.includes("acknowledgedAt = NULL"));
    expect(update?.sql).toContain("COALESCE(assignedTo, '') = ?");
    expect(update?.params).toEqual([
      "operator-2",
      "Sam Crew",
      "operator-1",
      expect.any(String),
      "incident-1",
      "org-1",
      "",
    ]);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: ["operator-2"],
      message: "Sam Crew is now responsible for this issue.",
    }));
  });

  it("makes a repeated assignment idempotent", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["incidents:access"], today: "2026-08-27" });
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({
        calls,
        incident: { id: "incident-1", status: "open", assignedTo: "operator-2", acknowledgedAt: null },
      }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "assign", targetUserId: "operator-2" },
    );
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("makes unassigning an empty queue idempotent", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["incidents:access"], today: "2026-08-27" });
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "unassign" },
    );
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.sql.startsWith("UPDATE incident"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("rejects a stale concurrent reassignment without notifying", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["incidents:access"], today: "2026-08-27" });
    const response = await post(
      fakeDatabase({
        changes: 0,
        incident: { id: "incident-1", status: "open", assignedTo: "operator-2", acknowledgedAt: null },
        responders: [{ userId: "operator-3", role: "admin", name: "Jo Director" }],
      }),
      "/api/mobile/v1/incidents/incident-1/command?orgId=org-1",
      { action: "assign", targetUserId: "operator-3" },
    );
    expect(response.status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
