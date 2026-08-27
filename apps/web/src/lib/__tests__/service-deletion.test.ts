import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1: vi.fn(), getPrisma: vi.fn() }));
vi.mock("../d1", () => ({ getD1: mocks.getD1 }));
vi.mock("../db", () => ({ getPrisma: mocks.getPrisma }));

import { deleteServiceForOrg } from "../service-deletion.server";

describe("shared service deletion", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["live", "running", "paused"])("refuses to delete a %s show", async (status) => {
    mocks.getPrisma.mockReturnValue({
      rundown: { findFirst: vi.fn().mockResolvedValue({ id: "show-1", serviceDate: "2026-09-06", status }) },
    });
    await expect(deleteServiceForOrg({ orgId: "org-1", showId: "show-1" })).rejects.toThrow("Stop the show");
    expect(mocks.getD1).not.toHaveBeenCalled();
  });

  it("deletes the complete show graph in one tenant-scoped batch", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const database = {
      prepare(sql: string) {
        return { bind: (...params: unknown[]) => ({ sql, params, run: vi.fn() }) };
      },
      batch: vi.fn(async (rows: { sql: string; params: unknown[] }[]) => {
        statements.push(...rows);
        return [];
      }),
    };
    mocks.getPrisma.mockReturnValue({
      rundown: { findFirst: vi.fn().mockResolvedValue({ id: "show-1", serviceDate: "2026-09-06", status: "stopped" }) },
      appSetting: { findMany: vi.fn().mockResolvedValue([{ value: JSON.stringify({ playback: "stop" }) }]) },
    });
    mocks.getD1.mockReturnValue(database);
    await expect(deleteServiceForOrg({ orgId: "org-1", showId: "show-1" })).resolves.toEqual({ ok: true });
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(statements.some((statement) => statement.sql === "DELETE FROM rundown WHERE orgId = ? AND id = ?" && statement.params.join(":") === "org-1:show-1")).toBe(true);
    expect(statements.every((statement) => statement.params.includes("org-1"))).toBe(true);
  });
});
