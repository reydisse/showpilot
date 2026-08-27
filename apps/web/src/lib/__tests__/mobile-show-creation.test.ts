import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
} from "../mobile-api.server";
import { PlanLimitError } from "../plan-limits";

const mocks = vi.hoisted(() => ({
  createServiceForOrg: vi.fn(),
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

vi.mock("../service-creation.server", () => ({
  createServiceForOrg: mocks.createServiceForOrg,
}));

const database: MobileApiDatabase = {
  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  },
  prepare(sql: string) {
    return {
      bind() {
        return {
          async first<T>() {
            if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
              return { id: "org-1" } as T;
            }
            return null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    };
  },
};

async function createShow(body: Record<string, unknown>) {
  const response = await handleMobileApi(
    new Request("https://showpilot.tech/api/mobile/v1/rundowns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { DB: database },
  );
  if (!response) throw new Error("Mobile API did not handle show creation");
  return response;
}

describe("mobile show creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Mobile Owner", email: "owner@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "owner",
      permissions: ["schedule:manage"],
    });
    mocks.createServiceForOrg.mockResolvedValue({
      ok: true,
      showId: "show-new",
      serviceDate: "2026-09-06",
    });
  });

  it("creates a show through the shared schedule mutation", async () => {
    const response = await createShow({
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "  Sunday Morning  ",
      startTime: "09:30",
      location: "  Main auditorium  ",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      showId: "show-new",
      serviceDate: "2026-09-06",
    });
    expect(mocks.createServiceForOrg).toHaveBeenCalledWith({
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      startTime: "09:30",
      location: "Main auditorium",
    });
  });

  it("requires schedule management access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [] });

    const response = await createShow({
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
    });

    expect(response.status).toBe(403);
    expect(mocks.createServiceForOrg).not.toHaveBeenCalled();
  });

  it("rejects invalid dates and wall-clock times at the HTTP boundary", async () => {
    const invalidDate = await createShow({
      orgId: "org-1",
      serviceDate: "2026-02-30",
      name: "Sunday Morning",
    });
    const invalidTime = await createShow({
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      startTime: "25:00",
    });

    expect(invalidDate.status).toBe(400);
    expect(invalidTime.status).toBe(400);
    expect(mocks.createServiceForOrg).not.toHaveBeenCalled();
  });

  it("returns the plan-limit message without creating a partial show", async () => {
    mocks.createServiceForOrg.mockRejectedValue(
      new PlanLimitError("The free plan allows up to 3 shows."),
    );

    const response = await createShow({
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: "The free plan allows up to 3 shows.",
    });
  });
});
