import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
  sendInvite: vi.fn(),
  inventory: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../show-inventory-write.server", () => ({ writeShowInventory: mocks.inventory }));

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
        if (sql.startsWith("SELECT id, serviceDate, scheduledCallTime, status, updatedAt FROM rundown")) {
          const showId = params[0];
          if (showId === "show-target") return { id: showId, serviceDate: "2026-09-13", scheduledCallTime: null, status: "stopped", updatedAt: "target-v1" } as T;
          if (showId === "show-source") return { id: showId, serviceDate: "2026-09-06", scheduledCallTime: null, status: "stopped", updatedAt: "source-v1" } as T;
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
    mocks.inventory.mockResolvedValue({ result: { id: "inventory-request-1", outcome: "applied" }, appliedNow: true });
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
      "crew-1", "manager-1", "Camera 1", "Video", "08:15",
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

  it("delegates validated native inventory creation to the shared authorized writer", async () => {
    const response = await post(
      parityDatabase({ calls: [] }),
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
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: "inventory-request-1",
      created: true,
    });
    expect(mocks.inventory).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        userId: "manager-1",
        requestId: "inventory-request-1",
        operation: {
          kind: "create",
          name: "Sunday Morning",
          description: "Main weekly show",
          location: "Auditorium",
          defaultStartTime: "09:30",
          sourceTemplateId: "template-1",
        },
      },
      expect.any(Headers),
    );
  });

  it("derives the same archive request for older native retries at the reviewed version", async () => {
    const calls: QueryCall[] = [],
      path =
        "/api/mobile/v1/schedule/inventory/inventory-1/archive?orgId=org-1";
    const body = { expectedUpdatedAt: "2026-11-08T00:00:00.000Z" };
    for (let index = 0; index < 2; index++) {
      const response = await post(parityDatabase({ calls }), path, body);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    const first = mocks.inventory.mock.calls[0][0],
      second = mocks.inventory.mock.calls[1][0];
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      orgId: "org-1",
      userId: "manager-1",
      operation: {
        kind: "archive",
        id: "inventory-1",
        archived: true,
        expectedUpdatedAt: body.expectedUpdatedAt,
      },
    });
    expect(first.requestId).toHaveLength(64);
    expect(
      calls.some((call) => call.sql.startsWith("UPDATE show_inventory_item")),
    ).toBe(false);
  });
});
