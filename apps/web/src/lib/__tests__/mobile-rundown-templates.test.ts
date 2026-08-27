import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiEnvironment,
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
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

interface QueryCall {
  sql: string;
  params: unknown[];
  operation: "first" | "all" | "run";
}

const templateItem = {
  id: "saved-item-1",
  title: "Welcome",
  type: "segment",
  duration: 300_000,
  notes: "Open warmly",
  assignee: "Host",
  cue: "GO",
  status: "upcoming",
  sortOrder: 0,
  hardStop: false,
  actualStart: null,
  actualEnd: null,
};

function storedTemplate() {
  return JSON.stringify({
    id: "template-1",
    name: "Sunday standard",
    serviceName: "Sunday Morning",
    scheduledStartTime: "09:30",
    items: [templateItem],
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  });
}

function fakeDatabase(calls: QueryCall[]): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        calls.push({ sql, params, operation: "first" });
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.includes("SELECT id, serviceDate, name, scheduledStartTime")) {
          if (params[0] === "show-previous") {
            return { id: "show-previous", serviceDate: "2026-08-23", name: "Previous Service", scheduledStartTime: "2026-08-23T08:15:00.000Z", location: "Auditorium" } as T;
          }
          return { id: "show-1", serviceDate: "2026-08-30", name: "Live Service", scheduledStartTime: "2026-08-30T09:00:00.000Z" } as T;
        }
        if (sql.includes("SELECT id, serviceDate FROM rundown")) {
          return { id: "show-1", serviceDate: "2026-08-30" } as T;
        }
        if (sql.startsWith("SELECT id FROM rundown")) return { id: "show-1" } as T;
        if (sql.includes("key = 'org-timezone'")) return { value: "UTC" } as T;
        if (sql.includes("key = ? LIMIT 1") && params[1] === "rundown-saved:template-1") {
          return { value: storedTemplate() } as T;
        }
        return null;
      },
      async all<T>() {
        calls.push({ sql, params, operation: "all" });
        if (sql.includes("FROM rundown_item")) {
          return { results: [{
            itemId: "item-1",
            title: "Opening",
            type: "segment",
            duration: 120_000,
            notes: "",
            assignee: "Host",
            cue: "",
            status: "live",
            sortOrder: 0,
            hardStop: 0,
            lowerThirdId: null,
            scheduledStart: null,
            expectedEnd: null,
            actualStart: "2026-08-30T09:00:00.000Z",
            actualEnd: null,
          }] as T[] };
        }
        if (sql.includes("key LIKE 'rundown-saved:%'")) return { results: [] as T[] };
        return { results: [] as T[] };
      },
      async run() {
        calls.push({ sql, params, operation: "run" });
        return { success: true, meta: { changes: 1 } };
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

function relayNamespace(fetchImplementation: (request: Request) => Promise<Response>) {
  return {
    idFromName: vi.fn(() => ({ toString: () => "show-room" })),
    get: vi.fn(() => ({ fetch: vi.fn(fetchImplementation) })),
  } as unknown as DurableObjectNamespace;
}

async function post(path: string, body: Record<string, unknown>, env: MobileApiEnvironment) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  if (!response) throw new Error("Mobile API did not handle rundown template route");
  return response;
}

describe("mobile rundown templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "editor-1", name: "Editor", email: "editor@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "sm", permissions: ["rundown:edit"], today: "2026-08-27" });
  });

  it("saves the durable rundown snapshot with service metadata and reset timing", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      "/api/mobile/v1/rundowns/show-1/templates?orgId=org-1",
      { requestId: "template-save-1", name: "Opening standard" },
      { DB: fakeDatabase(calls) },
    );

    expect(response.status).toBe(201);
    const templateWrite = calls.find((call) => call.operation === "run" && call.params[2] === "rundown-saved:template-save-1");
    expect(templateWrite).toBeDefined();
    const saved = JSON.parse(String(templateWrite?.params[3]));
    expect(saved).toMatchObject({
      id: "template-save-1",
      name: "Opening standard",
      serviceName: "Live Service",
      scheduledStartTime: "09:00",
    });
    expect(saved.items[0]).toMatchObject({ status: "upcoming", actualStart: null, actualEnd: null });
  });

  it("loads through the revision-protected relay with fresh item IDs and metadata", async () => {
    const calls: QueryCall[] = [];
    let relayRequest: Request | null = null;
    const relay = relayNamespace(async (request) => {
      relayRequest = request;
      return Response.json({ ok: true, revision: 8 });
    });
    const response = await post(
      "/api/mobile/v1/rundowns/show-1/templates/template-1/load?orgId=org-1",
      { requestId: "template-load-1", expectedRevision: 7 },
      { DB: fakeDatabase(calls), RUNDOWN_RELAY: relay },
    );

    expect(response.status).toBe(200);
    expect(relayRequest).not.toBeNull();
    expect(new URL(relayRequest!.url).searchParams.get("access")).toBe("edit");
    const command = await relayRequest!.json() as Record<string, unknown>;
    expect(command).toMatchObject({ action: "seed", id: "template-load-1", expectedRevision: 7 });
    expect(command.payload).toMatchObject({
      force: true,
      serviceName: "Sunday Morning",
      scheduledStartTime: "2026-08-30T09:30:00.000Z",
      items: [expect.objectContaining({ id: "template-load-1-item-0", status: "upcoming" })],
    });
  });

  it("does not apply a template over a newer operator revision", async () => {
    const calls: QueryCall[] = [];
    const relay = relayNamespace(async () => Response.json({
      ok: false,
      reason: "revision-conflict",
      revision: 9,
    }, { status: 409 }));
    const response = await post(
      "/api/mobile/v1/rundowns/show-1/templates/template-1/load?orgId=org-1",
      { requestId: "template-load-2", expectedRevision: 7 },
      { DB: fakeDatabase(calls), RUNDOWN_RELAY: relay },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Another operator changed the rundown first.",
    });
  });

  it("updates show metadata through the same revision-protected relay", async () => {
    const calls: QueryCall[] = [];
    let relayRequest: Request | null = null;
    const relay = relayNamespace(async (request) => {
      relayRequest = request;
      return Response.json({ ok: true, revision: 11 });
    });
    const response = await post(
      "/api/mobile/v1/rundowns/show-1/meta?orgId=org-1",
      {
        requestId: "show-meta-1",
        expectedRevision: 10,
        name: "Evening Service",
        startTime: "18:30",
        location: "Chapel",
      },
      { DB: fakeDatabase(calls), RUNDOWN_RELAY: relay },
    );

    expect(response.status).toBe(200);
    const command = await relayRequest!.json() as Record<string, unknown>;
    expect(command).toMatchObject({
      action: "update-meta",
      id: "show-meta-1",
      expectedRevision: 10,
      payload: {
        serviceName: "Evening Service",
        scheduledStartTime: "2026-08-30T18:30:00.000Z",
        location: "Chapel",
      },
    });
  });

  it("copies a previous show through the relay without carrying live timing", async () => {
    const calls: QueryCall[] = [];
    let relayRequest: Request | null = null;
    const relay = relayNamespace(async (request) => {
      relayRequest = request;
      return Response.json({ ok: true, revision: 13 });
    });
    const response = await post(
      "/api/mobile/v1/rundowns/show-1/previous/show-previous/load?orgId=org-1",
      { requestId: "previous-load-1", expectedRevision: 12 },
      { DB: fakeDatabase(calls), RUNDOWN_RELAY: relay },
    );

    expect(response.status).toBe(200);
    const command = await relayRequest!.json() as Record<string, unknown>;
    expect(command).toMatchObject({
      action: "seed",
      id: "previous-load-1",
      expectedRevision: 12,
      payload: {
        force: true,
        serviceName: "Previous Service",
        scheduledStartTime: "2026-08-30T08:15:00.000Z",
        location: "Auditorium",
        items: [expect.objectContaining({
          id: "previous-load-1-item-0",
          status: "upcoming",
          scheduledStart: null,
          actualStart: null,
          actualEnd: null,
        })],
      },
    });
  });
});
