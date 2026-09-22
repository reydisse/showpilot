import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), resolveAccess: vi.fn() }));

vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: mocks.getSession } }) }));
vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

interface QueryCall { sql: string; params: unknown[] }

function database(calls: QueryCall[]): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    calls.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id")) return { id: "org-1" } as T;
        if (sql.includes("FROM rundown r") && sql.includes("active-show-id")) {
          return {
            id: "show-1", serviceDate: "2026-09-21", name: "Evening Service",
            status: "stopped", scheduledStartTime: "2026-09-21T23:00:00.000Z",
          } as T;
        }
        if (sql.startsWith("SELECT id, serviceDate, name, status, scheduledStartTime FROM rundown")) {
          return {
            id: "show-1", serviceDate: "2026-09-21", name: "Evening Service",
            status: "stopped", scheduledStartTime: "2026-09-21T23:00:00.000Z",
          } as T;
        }
        if (sql.includes("FROM rundown_item WHERE")) {
          return { total: 2, complete: 2, missingDuration: 0, missingOwner: 0 } as T;
        }
        if (sql.includes("FROM checklist_entry WHERE")) return { total: 3, complete: 2 } as T;
        if (sql.includes("COUNT(*) AS count FROM incident")) return { count: 40 } as T;
        if (sql.includes("COUNT(*) AS count FROM equipment")) return { count: 35 } as T;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM incident WHERE")) return { results: [{ id: "fault-preview" }] as T[] };
        if (sql.includes("FROM equipment WHERE")) return { results: [{ id: "asset-preview" }] as T[] };
        if (sql.includes("FROM cue_column")) return { results: [] as T[] };
        if (sql.includes("FROM rundown_item") || sql.includes("FROM cue_note")) return { results: [] as T[] };
        if (sql.startsWith("SELECT id, serviceDate, name, scheduledStartTime FROM rundown")) {
          return { results: [{ id: "show-1", serviceDate: "2026-09-21", name: "Evening Service", scheduledStartTime: "2026-09-21T23:00:00.000Z" }] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
  }
  return {
    prepare(sql) { return { bind: (...params) => statement(sql, params) }; },
    async batch(statements) { return Promise.all(statements.map((entry) => entry.run())); },
  };
}

async function get(path: string, calls: QueryCall[]) {
  const response = await handleMobileApi(new Request(`https://showpilot.test${path}`), { DB: database(calls) });
  if (!response) throw new Error("Mobile API route was not handled");
  return response;
}

describe("mobile operational summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "manager-1", name: "Manager", email: "manager@example.com" } });
    mocks.resolveAccess.mockResolvedValue({
      role: "admin",
      permissions: ["dashboard:pm", "dashboard:tm", "cuesheet:view"],
      today: "2026-09-21",
    });
  });

  it("excludes structural headings and returns uncapped dashboard totals", async () => {
    const calls: QueryCall[] = [];
    const response = await get("/api/mobile/v1/dashboards/tm?orgId=org-1", calls);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: { total: 2, complete: 2, missingDuration: 0, missingOwner: 0 },
      incidents: [{ id: "fault-preview" }],
      equipment: [{ id: "asset-preview" }],
      totals: { openIncidents: 40, equipmentAttention: 35 },
    });
    expect(calls.find((call) => call.sql.includes("FROM rundown_item WHERE"))?.sql)
      .toContain("LOWER(TRIM(type)) NOT IN ('header', 'heading', 'section')");
  });

  it("returns the selected cue-sheet show's scheduled start time", async () => {
    const calls: QueryCall[] = [];
    const response = await get("/api/mobile/v1/cue-sheets?orgId=org-1&showId=show-1", calls);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      show: { id: "show-1", scheduledStartTime: "2026-09-21T23:00:00.000Z" },
      shows: [{ id: "show-1", scheduledStartTime: "2026-09-21T23:00:00.000Z" }],
    });
  });
});
