import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
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

interface QueryCall {
  sql: string;
  params: unknown[];
  operation: "first" | "all" | "run";
}

const sourceRows = [
  { id: "source-1", crewMemberId: "crew-1", role: "Camera 1", department: "Video", callTime: "08:15" },
  { id: "source-2", crewMemberId: null, role: "Camera 2", department: "Video", callTime: "" },
];

function parityDatabase(input: {
  calls: QueryCall[];
  copiedRows?: Array<typeof sourceRows[number] & { invitedAt: string | null }>;
  templateValue?: string;
}): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        input.calls.push({ sql, params, operation: "first" });
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT id, serviceDate, status, updatedAt FROM rundown")) {
          const showId = params[0];
          if (showId === "show-target") return { id: showId, serviceDate: "2026-09-13", status: "stopped", updatedAt: "target-v1" } as T;
          if (showId === "show-source") return { id: showId, serviceDate: "2026-09-06", status: "stopped", updatedAt: "source-v1" } as T;
          return null;
        }
        if (sql.startsWith("SELECT id, name, description, location, defaultStartTime, sourceTemplateId")) return null;
        if (sql.startsWith("SELECT value FROM app_setting") && String(params[1]).startsWith("rundown-saved:")) {
          return input.templateValue ? { value: input.templateValue } as T : null;
        }
        return null;
      },
      async all<T>() {
        input.calls.push({ sql, params, operation: "all" });
        if (sql.includes("ORDER BY department ASC")) return { results: sourceRows as T[] };
        if (sql.includes("ORDER BY id ASC")) return { results: (input.copiedRows ?? []) as T[] };
        return { results: [] as T[] };
      },
      async run() {
        input.calls.push({ sql, params, operation: "run" });
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      return Promise.all(statements.map((entry) => entry.run()));
    },
  };
}

async function post(db: MobileApiDatabase, path: string, body: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { DB: db });
  if (!response) throw new Error("Mobile API did not handle schedule parity route");
  return response;
}

describe("mobile schedule parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "manager-1", name: "Manager", email: "manager@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["schedule:manage"], today: "2026-08-27" });
    mocks.sendInvite.mockResolvedValue({ delivered: true, reason: null });
  });

  it("copies a previous team atomically, resets responses, and invites assigned crew", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      parityDatabase({ calls }),
      "/api/mobile/v1/schedule/services/show-target/copy-team?orgId=org-1",
      { requestId: "copy-show-source-show-target", sourceShowId: "show-source" },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true, copied: 2, created: true, delivered: 1, total: 1 });
    const inserts = calls.filter((call) => call.sql.startsWith("INSERT INTO service_assignment"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params).toEqual([
      "copy-show-source-show-target-0", "org-1", "show-target", "2026-09-13",
      "crew-1", "Camera 1", "Video", "08:15",
    ]);
    expect(mocks.sendInvite).toHaveBeenCalledOnce();
    expect(mocks.sendInvite).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: "copy-show-source-show-target-0",
      serviceDate: "2026-09-13",
    }));
  });

  it("retries a completed team copy without duplicate rows or invitations", async () => {
    const calls: QueryCall[] = [];
    const copiedRows = sourceRows.map((row, index) => ({
      ...row,
      id: `copy-show-source-show-target-${index}`,
      invitedAt: row.crewMemberId ? "2026-08-27 10:00:00" : null,
    }));
    const response = await post(
      parityDatabase({ calls, copiedRows }),
      "/api/mobile/v1/schedule/services/show-target/copy-team?orgId=org-1",
      { requestId: "copy-show-source-show-target", sourceShowId: "show-source" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, copied: 2, created: false, delivered: 1, total: 1 });
    expect(calls.some((call) => call.sql.startsWith("INSERT INTO service_assignment"))).toBe(false);
    expect(mocks.sendInvite).not.toHaveBeenCalled();
  });

  it("creates a retry-safe inventory snapshot from a saved rundown template", async () => {
    const calls: QueryCall[] = [];
    const templateValue = JSON.stringify([{ id: "old-item", title: "Welcome", status: "complete", actualStart: "old" }]);
    const response = await post(
      parityDatabase({ calls, templateValue }),
      "/api/mobile/v1/schedule/inventory?orgId=org-1",
      {
        requestId: "inventory-request-1",
        name: "Sunday Morning",
        description: "Main weekly show",
        location: "Auditorium",
        defaultStartTime: "09:30",
        sourceTemplateId: "template-1",
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true, id: "inventory-request-1", created: true });
    const insert = calls.find((call) => call.sql.startsWith("INSERT INTO show_inventory_item"));
    const rundownJson = insert?.params[6];
    expect(typeof rundownJson).toBe("string");
    expect(JSON.parse(String(rundownJson))).toEqual([expect.objectContaining({
      id: "inventory-request-1-item-0",
      title: "Welcome",
      status: "upcoming",
      scheduledStart: null,
      actualStart: null,
      actualEnd: null,
    })]);
  });

  it("archives inventory only at the version the manager viewed", async () => {
    const calls: QueryCall[] = [];
    const response = await post(
      parityDatabase({ calls }),
      "/api/mobile/v1/schedule/inventory/inventory-1/archive?orgId=org-1",
      { expectedUpdatedAt: "inventory-v1" },
    );

    expect(response.status).toBe(200);
    const update = calls.find((call) => call.sql.startsWith("UPDATE show_inventory_item"));
    expect(update?.sql).toContain("archivedAt = CURRENT_TIMESTAMP");
    expect(update?.params).toEqual(["inventory-1", "org-1", "inventory-v1"]);
  });
});
