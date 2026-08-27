import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPlanLimit: vi.fn(),
  getPrisma: vi.fn(),
  getRundownState: vi.fn(),
  normalizeItems: vi.fn(),
  persistItems: vi.fn(),
  readInventory: vi.fn(),
}));

vi.mock("../db", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("../plan-limits", () => ({ checkPlanLimit: mocks.checkPlanLimit }));
vi.mock("../rundown", () => ({
  getRundownStateForOrg: mocks.getRundownState,
  normalizeLegacyRundownItems: mocks.normalizeItems,
  persistRundownItemsForOrg: mocks.persistItems,
}));
vi.mock("../show-inventory", () => ({ readShowInventoryItem: mocks.readInventory }));

import { createServiceForOrg } from "../service-creation.server";

function prisma(existing: Record<string, unknown> | null = null) {
  return {
    appSetting: {
      findUnique: vi.fn().mockResolvedValue({ value: "Africa/Accra" }),
      deleteMany: vi.fn(),
    },
    rundown: {
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue({ id: "mobile-show-1" }),
      deleteMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(existing),
    },
    $transaction: vi.fn(),
  };
}

describe("service creation request idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPlanLimit.mockResolvedValue(undefined);
    mocks.persistItems.mockResolvedValue(undefined);
    mocks.readInventory.mockResolvedValue(null);
  });

  it("returns the original show for an identical repeated request without consuming the plan limit", async () => {
    const database = prisma({
      id: "mobile-show-1",
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      location: "Main auditorium",
      scheduledStartTime: new Date("2026-09-06T09:30:00.000Z"),
    });
    mocks.getPrisma.mockReturnValue(database);
    await expect(createServiceForOrg({
      orgId: "org-1",
      requestId: "mobile-show-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      startTime: "09:30",
      location: "Main auditorium",
    })).resolves.toEqual({ ok: true, showId: "mobile-show-1", serviceDate: "2026-09-06" });
    expect(database.rundown.create).not.toHaveBeenCalled();
    expect(mocks.checkPlanLimit).not.toHaveBeenCalled();
  });

  it("rejects reuse of a request ID with changed show details", async () => {
    mocks.getPrisma.mockReturnValue(prisma({
      id: "mobile-show-1",
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      location: "Main auditorium",
      scheduledStartTime: new Date("2026-09-06T09:30:00.000Z"),
    }));
    await expect(createServiceForOrg({
      orgId: "org-1",
      requestId: "mobile-show-1",
      serviceDate: "2026-09-06",
      name: "Sunday Evening",
      startTime: "09:30",
      location: "Main auditorium",
    })).rejects.toThrow("different details");
  });

  it("checks inventory-backed retries against the exact created show details", async () => {
    mocks.readInventory.mockResolvedValue({
      id: "inventory-1",
      name: "Inventory default",
      location: "Main room",
      defaultStartTime: "10:00",
    });
    mocks.getPrisma.mockReturnValue(prisma({
      id: "mobile-show-1",
      orgId: "org-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      location: "Main room",
      scheduledStartTime: new Date("2026-09-06T10:00:00.000Z"),
    }));

    await expect(createServiceForOrg({
      orgId: "org-1",
      requestId: "mobile-show-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      location: "Main room",
      startTime: "10:00",
      inventoryId: "inventory-1",
    })).resolves.toEqual({ ok: true, showId: "mobile-show-1", serviceDate: "2026-09-06" });

    await expect(createServiceForOrg({
      orgId: "org-1",
      requestId: "mobile-show-1",
      serviceDate: "2026-09-06",
      name: "Changed title",
      location: "Main room",
      startTime: "10:00",
      inventoryId: "inventory-1",
    })).rejects.toThrow("different details");
  });

  it("uses the client request ID as the new show ID and persists one clean rundown", async () => {
    const database = prisma();
    mocks.getPrisma.mockReturnValue(database);
    await createServiceForOrg({
      orgId: "org-1",
      requestId: "mobile-show-1",
      serviceDate: "2026-09-06",
      name: "Sunday Morning",
      startTime: "09:30",
      location: "Main auditorium",
    });
    expect(database.rundown.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: "mobile-show-1", orgId: "org-1" }),
    }));
    expect(mocks.persistItems).toHaveBeenCalledWith("org-1", "2026-09-06", [], "mobile-show-1");
  });
});
