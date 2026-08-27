import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
  setDestinationEnabled: vi.fn(),
  deleteDestination: vi.fn(),
  getLiveInputStatus: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../stream-destinations", () => ({
  setStreamDestinationEnabledForOrg: mocks.setDestinationEnabled,
  deleteStreamDestinationForOrg: mocks.deleteDestination,
}));

vi.mock("../stream", () => ({
  getLiveInputStatusForOrg: mocks.getLiveInputStatus,
}));

interface QueryCall {
  sql: string;
  params: unknown[];
  operation: "first" | "all" | "run";
}

function fakeDatabase(input: {
  calls: QueryCall[];
  destination?: { rtmpUrl: string; streamKey: string; cfOutputId: string } | null;
  changes?: number;
}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        input.calls.push({ sql, params, operation: "first" });
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT rtmpUrl, streamKey, cfOutputId FROM stream_destination")) {
          return (input.destination ?? null) as T | null;
        }
        return null;
      },
      async all<T>() {
        input.calls.push({ sql, params, operation: "all" });
        if (sql.startsWith("SELECT id, name, status, rtmpUrl")) {
          return { results: [{ id: "input-1", name: "Main", status: "connected", rtmpUrl: "rtmps://input", srtUrl: "srt://input", createdAt: "2026-08-27" }] as T[] };
        }
        if (sql.includes("CASE WHEN streamKey = ''")) {
          return { results: [{ id: "dest-1", name: "YouTube", platform: "youtube", rtmpUrl: "rtmps://youtube", enabled: 1, cfOutputId: "cf-1", liveInputId: "input-1", createdAt: "2026-08-27", hasStreamKey: 1 }] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        input.calls.push({ sql, params, operation: "run" });
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

async function request(db: MobileApiDatabase, path: string, method: "GET" | "POST", body?: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle operations route");
  return response;
}

describe("mobile operations API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "operator-1", name: "Ada", email: "ada@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["stream_health:manage", "assets:manage"], today: "2026-08-27" });
    mocks.setDestinationEnabled.mockResolvedValue(undefined);
    mocks.deleteDestination.mockResolvedValue(undefined);
    mocks.getLiveInputStatus.mockResolvedValue({ inputId: "input-1", status: "streaming", providerStatus: "connected", checkedAt: "2026-08-27T12:00:00.000Z" });
  });

  it("returns streaming health without exposing provider stream keys", async () => {
    const calls: QueryCall[] = [];
    const response = await request(fakeDatabase({ calls }), "/api/mobile/v1/streaming?orgId=org-1", "GET");
    expect(response.status).toBe(200);
    const body = await response.json() as { destinations: Array<Record<string, unknown>> };
    expect(body.destinations[0]).toMatchObject({ enabled: true, connected: true, hasStreamKey: true });
    expect(mocks.getLiveInputStatus).toHaveBeenCalledWith("org-1", "input-1");
    expect(body.destinations[0]).not.toHaveProperty("streamKey");
    expect(calls.find((call) => call.sql.includes("CASE WHEN streamKey"))?.params).toEqual(["org-1"]);
  });

  it("creates destinations disconnected until an operator enables the provider output", async () => {
    const calls: QueryCall[] = [];
    const response = await request(fakeDatabase({ calls }), "/api/mobile/v1/streaming/destinations?orgId=org-1", "POST", {
      name: "YouTube",
      platform: "YouTube",
      rtmpUrl: "rtmps://a.rtmp.youtube.com/live2",
      streamKey: "write-only-secret",
    });
    expect(response.status).toBe(200);
    const insert = calls.find((call) => call.sql.startsWith("INSERT INTO stream_destination"));
    expect(insert?.sql).toContain("VALUES (?, ?, ?, ?, ?, ?, 0, '', ''");
    expect(insert?.params.slice(1)).toEqual(["org-1", "YouTube", "youtube", "rtmps://a.rtmp.youtube.com/live2", "write-only-secret"]);
  });

  it("rejects credential edits while a provider output is connected", async () => {
    const calls: QueryCall[] = [];
    const response = await request(
      fakeDatabase({ calls, destination: { rtmpUrl: "rtmps://old.example/live", streamKey: "saved", cfOutputId: "cf-output-1" } }),
      "/api/mobile/v1/streaming/destinations/dest-1?orgId=org-1",
      "POST",
      { name: "YouTube", platform: "youtube", rtmpUrl: "rtmps://new.example/live", streamKey: "" },
    );
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.sql.startsWith("UPDATE stream_destination"))).toBe(false);
  });

  it("uses the tenant-scoped provider helper when toggling an output", async () => {
    const response = await request(
      fakeDatabase({ calls: [] }),
      "/api/mobile/v1/streaming/destinations/dest-1?orgId=org-1",
      "POST",
      { action: "toggle", enabled: true },
    );
    expect(response.status).toBe(200);
    expect(mocks.setDestinationEnabled).toHaveBeenCalledWith("org-1", "dest-1", true);
  });

  it("rejects invalid asset enums before writing", async () => {
    const calls: QueryCall[] = [];
    const response = await request(fakeDatabase({ calls }), "/api/mobile/v1/assets?orgId=org-1", "POST", {
      name: "Mystery box",
      category: "invented-category",
      status: "available",
      location: "Store",
      serialNumber: "",
      notes: "",
    });
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO equipment"))).toBe(false);
  });

  it("rejects unsafe audio ranges before looking up a show or writing", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "tech-manager", permissions: ["dashboard:tm"], today: "2026-08-27" });
    const calls: QueryCall[] = [];
    const response = await request(fakeDatabase({ calls }), "/api/mobile/v1/audio?orgId=org-1", "POST", {
      showId: "show-1",
      channel: 1,
      label: "Lead vocal",
      micType: "wireless-handheld",
      micModel: "",
      notes: "",
      gainDb: 500,
      phantom: false,
      muted: false,
      group: "vocals",
      mixerConsole: "",
      mixerChannel: 1.5,
      mixerChannelType: "input",
    });
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.includes("FROM rundown WHERE id"))).toBe(false);
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO mic_assignment"))).toBe(false);
  });

  it("denies mutations without the operation permission", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["assets:view"], today: "2026-08-27" });
    const response = await request(fakeDatabase({ calls: [] }), "/api/mobile/v1/assets?orgId=org-1", "POST", {
      name: "Camera",
      category: "video",
      status: "available",
      location: "Store",
      serialNumber: "SP-1",
      notes: "",
    });
    expect(response.status).toBe(403);
  });

  it("returns a schema-complete empty cue sheet when no show exists", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["cuesheet:view"], today: "2026-08-27" });
    const response = await request(fakeDatabase({ calls: [] }), "/api/mobile/v1/cue-sheets?orgId=org-1", "GET");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      show: null,
      shows: [],
      canEdit: false,
      canAddNotes: false,
      columns: [],
      rows: [],
    });
  });
});
