import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  checkPlanLimit: vi.fn(),
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

vi.mock("../plan-limits", () => ({
  PlanLimitError: class PlanLimitError extends Error { status = 402; },
  checkPlanLimit: mocks.checkPlanLimit,
}));

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface ExistingDevice {
  id: string;
  orgId: string;
  name: string;
  category: string;
  adapterType: string;
  settings: string;
  enabled: boolean;
  updatedAt: string;
}

function fakeDatabase(input: { calls?: QueryCall[]; existing?: ExistingDevice | null; changes?: number } = {}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM device")) return { count: 2 } as T;
        if (sql.startsWith("SELECT id, orgId, name, category, adapterType")) return (input.existing ?? null) as T | null;
        return null;
      },
      async all<T>() {
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
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

async function post(db: MobileApiDatabase, path: string, body: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle device route");
  return response;
}

describe("mobile device management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "operator-1", name: "Ada", email: "ada@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["devices:access"], today: "2026-08-27" });
    mocks.checkPlanLimit.mockResolvedValue(undefined);
  });

  it("creates a tenant-owned device with server-derived adapter metadata", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/devices?orgId=org-1", {
      name: "Main ATEM",
      adapterType: "atem",
      enabled: true,
      settings: { host: "10.0.0.20", port: "9910", inventedSecret: "drop-me" },
    });
    expect(response.status).toBe(201);
    expect(mocks.checkPlanLimit).toHaveBeenCalledWith("org-1", "devices", 2);
    const insert = calls.find((call) => call.sql.startsWith("INSERT INTO device"));
    expect(insert?.params.slice(1, 6)).toEqual([
      "org-1",
      "Main ATEM",
      "video",
      "atem",
      JSON.stringify({ host: "10.0.0.20", port: 9910 }),
    ]);
    expect(String(insert?.params[5])).not.toContain("inventedSecret");
  });

  it("preserves an existing password when an edit leaves the secret blank", async () => {
    const calls: QueryCall[] = [];
    const existing: ExistingDevice = {
      id: "obs-1",
      orgId: "org-1",
      name: "Stream OBS",
      category: "streaming",
      adapterType: "obs",
      settings: JSON.stringify({ host: "10.0.0.40", port: 4455, password: "saved-secret" }),
      enabled: true,
      updatedAt: "2026-08-27",
    };
    const response = await post(fakeDatabase({ calls, existing }), "/api/mobile/v1/devices/obs-1?orgId=org-1", {
      name: "Updated OBS",
      adapterType: "obs",
      enabled: true,
      settings: { host: "10.0.0.41", port: "4455", password: "" },
    });
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.startsWith("UPDATE device SET name"));
    expect(JSON.parse(String(update?.params[3]))).toEqual({ host: "10.0.0.41", port: 4455, password: "saved-secret" });
    expect(update?.params.slice(-2)).toEqual(["obs-1", "org-1"]);
  });

  it("rejects incomplete configuration before writing", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/devices?orgId=org-1", {
      name: "Broken ATEM",
      adapterType: "atem",
      enabled: true,
      settings: { port: "9910" },
    });
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO device"))).toBe(false);
  });

  it("cannot update a device outside the organization", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls, existing: null }), "/api/mobile/v1/devices/foreign-device?orgId=org-1", {
      name: "Foreign",
      adapterType: "atem",
      enabled: true,
      settings: { host: "10.0.0.20" },
    });
    expect(response.status).toBe(404);
    expect(calls.some((call) => call.sql.startsWith("UPDATE device"))).toBe(false);
  });

  it("deletes only by device and organization", async () => {
    const calls: QueryCall[] = [];
    const response = await post(fakeDatabase({ calls }), "/api/mobile/v1/devices/atem-1/remove?orgId=org-1", {});
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.sql.startsWith("DELETE FROM device"))?.params).toEqual(["atem-1", "org-1"]);
  });
});
