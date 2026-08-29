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

interface CommentFixture {
  id: string;
  incidentId: string;
  userId: string;
  authorName: string;
  body: string;
  parentId: string | null;
  createdAt: string;
}

interface ReactionFixture {
  id: string;
  targetId: string;
  userId: string;
  authorName: string;
  emoji: string;
  createdAt: string;
}

function fakeDatabase(input: {
  calls?: QueryCall[];
  incident?: IncidentFixture | null;
  changes?: number;
  responders?: ResponderFixture[];
  grants?: GrantFixture[];
  discussionIncident?: { id: string; serviceDate: string; showId: string | null } | null;
  parentAuthorId?: string | null;
  existingComment?: CommentFixture | null;
  reactionTarget?: { userId: string; incidentId: string } | null;
  incidentRows?: Array<Record<string, unknown>>;
  commentRows?: CommentFixture[];
  reactionRows?: ReactionFixture[];
  historyTotal?: number;
  historyRows?: Array<Record<string, unknown>>;
  historyCategories?: string[];
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
        if (sql.startsWith("SELECT id, serviceDate, showId FROM incident")) {
          return (input.discussionIncident === undefined
            ? { id: "incident-1", serviceDate: "2026-08-27", showId: "show-1" }
            : input.discussionIncident) as T | null;
        }
        if (sql.startsWith("SELECT userId FROM incident_comment")) {
          return (input.parentAuthorId ? { userId: input.parentAuthorId } : null) as T | null;
        }
        if (sql.includes("FROM incident_comment WHERE id = ? AND orgId = ? AND userId = ?")) {
          return (input.existingComment ?? null) as T | null;
        }
        if (sql.startsWith("SELECT c.userId, c.incidentId FROM incident_comment")) {
          return (input.reactionTarget === undefined
            ? { userId: "operator-2", incidentId: "incident-1" }
            : input.reactionTarget) as T | null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS total FROM incident i")) {
          return { total: input.historyTotal ?? 0 } as T;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM incident i WHERE") && sql.includes("ORDER BY")) {
          return { results: (input.historyRows ?? []) as T[] };
        }
        if (sql.startsWith("SELECT DISTINCT lower(trim(category)) AS category FROM incident")) {
          return { results: (input.historyCategories ?? []).map((category) => ({ category })) as T[] };
        }
        if (sql.includes("FROM incident WHERE orgId = ?")) {
          return { results: (input.incidentRows ?? []) as T[] };
        }
        if (sql.includes("FROM incident_comment WHERE orgId = ? AND incidentId IN")) {
          return { results: (input.commentRows ?? []) as T[] };
        }
        if (sql.includes("FROM content_reaction r JOIN incident_comment c")) {
          return { results: (input.reactionRows ?? []) as T[] };
        }
        if (sql.includes("FROM member m JOIN user u")) {
          return { results: (input.responders ?? []) as T[] };
        }
        if (sql.includes("FROM member_permission_grant")) {
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

async function get(db: MobileApiDatabase, path: string) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`), { DB: db });
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

  it("posts a tenant-scoped incident comment and notifies leadership", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/incident-1/comments?orgId=org-1",
      { requestId: "comment-request-1", body: "Checked the stage box and replaced the cable." },
    );
    expect(response.status).toBe(200);
    const insert = calls.find((call) => call.sql.startsWith("INSERT OR IGNORE INTO incident_comment"));
    expect(insert?.params.slice(0, 4)).toEqual(["comment-request-1", "org-1", "incident-1", "operator-1"]);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      includeLeadership: true,
      message: "Checked the stage box and replaced the cable.",
    }));
  });

  it("rejects a reply target outside the incident", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls, parentAuthorId: null }),
      "/api/mobile/v1/incidents/incident-1/comments?orgId=org-1",
      { requestId: "comment-request-2", parentId: "foreign-comment", body: "Reply" },
    );
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("INSERT OR IGNORE INTO incident_comment"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("returns the original comment when the same request is retried", async () => {
    const existingComment: CommentFixture = {
      id: "comment-request-3",
      incidentId: "incident-1",
      userId: "operator-1",
      authorName: "Ada Operator",
      body: "Power-cycled the converter.",
      parentId: null,
      createdAt: "2026-08-27T09:00:00.000Z",
    };
    const response = await post(
      fakeDatabase({ changes: 0, existingComment }),
      "/api/mobile/v1/incidents/incident-1/comments?orgId=org-1",
      { requestId: existingComment.id, body: existingComment.body },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ comment: existingComment });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("adds a reaction idempotently and notifies the comment author", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls, reactionTarget: { userId: "operator-2", incidentId: "incident-1" } }),
      "/api/mobile/v1/incident-comments/comment-1/reaction?orgId=org-1",
      { emoji: "👀", active: true },
    );
    expect(response.status).toBe(200);
    const insert = calls.find((call) => call.sql.startsWith("INSERT OR IGNORE INTO content_reaction"));
    expect(insert?.params.slice(1, 5)).toEqual(["org-1", "comment-1", "operator-1", "Ada Operator"]);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: ["operator-2"],
      source: "comment-1",
    }));
  });

  it("does not duplicate notifications when an active reaction is retried", async () => {
    const response = await post(
      fakeDatabase({ changes: 0 }),
      "/api/mobile/v1/incident-comments/comment-1/reaction?orgId=org-1",
      { emoji: "👍", active: true },
    );
    expect(response.status).toBe(200);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("removes only the current user's requested reaction", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incident-comments/comment-1/reaction?orgId=org-1",
      { emoji: "🙏", active: false },
    );
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.sql.startsWith("DELETE FROM content_reaction"))?.params)
      .toEqual(["org-1", "comment-1", "operator-1", "🙏"]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("rejects a reaction target outside the organization", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      fakeDatabase({ calls, reactionTarget: null }),
      "/api/mobile/v1/incident-comments/foreign-comment/reaction?orgId=org-1",
      { emoji: "❤️", active: true },
    );
    expect(response.status).toBe(404);
    expect(calls.some((call) => call.sql.startsWith("INSERT OR IGNORE INTO content_reaction"))).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("loads only discussion rows attached to the returned organization incidents", async () => {
    const calls: QueryCall[] = [];
    const comment: CommentFixture = {
      id: "comment-1",
      incidentId: "incident-1",
      userId: "operator-2",
      authorName: "Sam Crew",
      body: "Cable replaced.",
      parentId: null,
      createdAt: "2026-08-27T09:00:00.000Z",
    };
    const response = await get(
      fakeDatabase({
        calls,
        incidentRows: [{ id: "incident-1", status: "open" }],
        commentRows: [comment],
        reactionRows: [{ id: "reaction-1", targetId: comment.id, userId: "operator-1", authorName: "Ada Operator", emoji: "👍", createdAt: "2026-08-27T09:01:00.000Z" }],
      }),
      "/api/mobile/v1/incidents?orgId=org-1",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      discussionEnabled: true,
      historyEnabled: true,
      comments: [comment],
      reactions: [expect.objectContaining({ id: "reaction-1", targetId: comment.id })],
    }));
    expect(calls.find((call) => call.sql.includes("FROM incident_comment WHERE"))?.params)
      .toEqual(["org-1", "incident-1"]);
    expect(calls.find((call) => call.sql.includes("FROM content_reaction r JOIN"))?.params)
      .toEqual(["org-1", "org-1", "incident-1"]);
  });

  it("applies advanced history filters with tenant scope and stable pagination", async () => {
    const calls: QueryCall[] = [];
    const historyIncident = { id: "incident-9", description: "Stage left audio failed", status: "resolved" };
    const response = await get(
      fakeDatabase({ calls, historyTotal: 31, historyRows: [historyIncident], historyCategories: ["audio", "video"] }),
      "/api/mobile/v1/incidents/history?orgId=org-1&status=open&severity=high&category=Audio&assignee=Sam&from=2026-08-01&to=2026-08-31&query=stage&sort=severity&page=2",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      total: 31,
      page: 2,
      pageSize: 30,
      categories: ["audio", "video"],
      incidents: [historyIncident],
    });
    const historyQuery = calls.find((call) => call.sql.includes("SELECT id, showId") && call.sql.includes("FROM incident i"));
    expect(historyQuery?.sql).toContain("CASE lower(i.severity)");
    expect(historyQuery?.params).toEqual([
      "org-1",
      "open",
      "high",
      "audio",
      "%sam%",
      "2026-08-01",
      "2026-08-31",
      "%stage%",
      "%stage%",
      "%stage%",
      "%stage%",
      30,
      30,
    ]);
  });

  it("rejects invalid history date ranges before querying incidents", async () => {
    const calls: QueryCall[] = [];
    const response = await get(
      fakeDatabase({ calls }),
      "/api/mobile/v1/incidents/history?orgId=org-1&from=2026-08-31&to=2026-08-01",
    );
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.includes("FROM incident i WHERE"))).toBe(false);
  });
});
