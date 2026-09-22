import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDuePostShowReminders } from "../show-report-notes";

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: mocks.notify,
}));

const candidate = {
  orgId: "org-1",
  showId: "show-1",
  showName: "Morning Show",
  serviceDate: "2026-09-20",
  scheduledStartTime: "2026-09-20T09:00:00.000Z",
  plannedDurationMs: 3_600_000,
  reminderHours: "1",
  userId: "manager-1",
};

function database() {
  const sql: string[] = [];
  let inserts = 0;
  return {
    sql,
    get inserts() { return inserts; },
    prepare(statement: string) {
      sql.push(statement);
      return {
        bind() {
          return {
            async all<T>() { return { results: [candidate] as T[] }; },
            async run() { inserts += 1; return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
}

describe("post-show reminder queue", () => {
  beforeEach(() => mocks.notify.mockReset());

  it("excludes sent rows and includes active permission grants", async () => {
    mocks.notify.mockResolvedValue({ notified: 1 });
    const db = database();
    await expect(createDuePostShowReminders(db, new Date("2026-09-21T12:00:00Z")))
      .resolves.toEqual({ created: 1 });

    expect(db.sql[0]).toContain("LEFT JOIN show_report_reminder sent");
    expect(db.sql[0]).toContain("sent.id IS NULL");
    expect(db.sql[0]).toContain("member_permission_grant");
    expect(db.inserts).toBe(1);
  });

  it("does not mark a reminder sent when durable delivery fails", async () => {
    mocks.notify.mockResolvedValue({ notified: 0 });
    const db = database();
    await expect(createDuePostShowReminders(db, new Date("2026-09-21T12:00:00Z")))
      .resolves.toEqual({ created: 0 });
    expect(db.inserts).toBe(0);
  });
});
