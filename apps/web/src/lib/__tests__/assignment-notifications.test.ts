import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAssignmentRecipient } from "../assignment-notifications.server";

const mocks = vi.hoisted(() => ({
  recipient: { userId: "user-1" } as { userId: string } | null,
  statements: [] as Array<{ sql: string; params: unknown[] }>,
  notifyOperationalEvent: vi.fn(),
}));

vi.mock("../d1", () => ({
  getD1: () => ({
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          mocks.statements.push({ sql, params });
          return {
            first: async () => mocks.recipient,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  }),
}));

vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: mocks.notifyOperationalEvent,
}));

const assignment = {
  orgId: "org-1",
  assignmentId: "assignment-1",
  crewEmail: "  Person@Example.com ",
  serviceName: "Sunday Service",
  serviceDate: "2026-09-30",
  role: "Stage manager",
  start: "3:30 PM",
};

describe("assignment notifications", () => {
  beforeEach(() => {
    mocks.recipient = { userId: "user-1" };
    mocks.statements.length = 0;
    mocks.notifyOperationalEvent.mockReset();
    mocks.notifyOperationalEvent.mockResolvedValue({ notified: 1 });
  });

  it("notifies the signed-in organization member matched by normalized email", async () => {
    await expect(notifyAssignmentRecipient(assignment)).resolves.toEqual({ notified: true });

    const lookup = mocks.statements.find((statement) => statement.sql.includes("JOIN user"));
    expect(lookup?.params).toEqual(["org-1", "person@example.com"]);
    expect(mocks.notifyOperationalEvent).toHaveBeenCalledWith({
      orgId: "org-1",
      recipientIds: ["user-1"],
      type: "assignment",
      severity: "info",
      title: "New assignment",
      message: "Stage manager · Sunday Service · 2026-09-30 · Call 3:30 PM",
      actionUrl: "schedule?date=2026-09-30&assignment=assignment-1",
      source: "assignment-1",
      pushTag: "assignment-assignment-1",
      dedupeKey: "assignment-assignment-1",
    });
  });

  it("replaces the previous actionable invite before sending a reminder", async () => {
    await notifyAssignmentRecipient({ ...assignment, reminder: true });

    const cleanup = mocks.statements.find((statement) =>
      statement.sql.startsWith("DELETE FROM notification"),
    );
    expect(cleanup?.params).toEqual(["org-1", "assignment-1"]);
    expect(mocks.notifyOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Assignment reminder" }),
    );
  });

  it("does not expose an assignment when the crew email has no org account", async () => {
    mocks.recipient = null;

    await expect(notifyAssignmentRecipient(assignment)).resolves.toEqual({ notified: false });
    expect(mocks.notifyOperationalEvent).not.toHaveBeenCalled();
    expect(mocks.statements.some((statement) =>
      statement.sql.startsWith("DELETE FROM notification"),
    )).toBe(false);
  });
});
