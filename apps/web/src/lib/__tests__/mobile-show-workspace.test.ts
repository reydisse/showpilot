import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiStatement,
} from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

interface WorkspaceFixtures {
  includeUpcomingShow?: boolean;
}

function fakeDatabase(fixtures: WorkspaceFixtures = {}): MobileApiDatabase {
  const includeUpcomingShow = fixtures.includeUpcomingShow !== false;
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) {
          return (params[0] === "org-1" ? { id: "org-1" } : null) as T | null;
        }
        if (sql.startsWith("SELECT id FROM organization WHERE slug = ?")) return null;
        if (sql.includes("FROM rundown\n     WHERE orgId = ? AND (status IN")) {
          return (includeUpcomingShow && params[0] === "org-1" ? {
            id: "show-1",
            serviceDate: "2026-08-30",
            name: "Sunday Service",
            scheduledStartTime: "2026-08-30T09:00:00.000Z",
            location: "Main Auditorium",
            status: "draft",
            updatedAt: "2026-08-27T12:00:00.000Z",
          } : null) as T | null;
        }
        if (sql.includes("key = ? LIMIT 1")) {
          const key = params[1];
          if (key === "rundown-timer:show-1") {
            return { value: JSON.stringify({ playback: "play", currentItemId: "item-1", elapsed: 1_000, startedAt: 2_000, pausedAt: null, mode: "count-down" }) } as T;
          }
          return null;
        }
        if (sql.includes("SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ?")) {
          return { id: "show-1" } as T;
        }
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async all<T>() {
        if (sql.includes("SELECT key, value FROM app_setting")) {
          return { results: [
            { key: "org-timezone", value: "Africa/Accra" },
            { key: "clock-format", value: "24hr" },
            { key: "rundown-adapter", value: "native" },
            { key: "active-show-id", value: "show-1" },
          ] as T[] };
        }
        if (sql.includes("FROM crew_member WHERE orgId = ?")) {
          return { results: params[0] === "org-1" ? [{
            id: "crew-1",
            memberId: "TD1",
            name: "Ada Director",
            role: "Technical Director",
            photoUrl: "",
            isOnline: 1,
            lastCheckIn: "2026-08-27T10:00:00.000Z",
            lastCheckOut: null,
          }] as T[] : [] };
        }
        if (sql.includes("FROM rundown_item WHERE orgId = ? AND showId = ?")) {
          return { results: params[0] === "org-1" && params[1] === "show-1" ? [{
            itemId: "item-1",
            title: "Welcome",
            type: "segment",
            duration: 300_000,
            notes: "Open doors",
            assignee: "Host",
            cue: "GO",
            status: "upcoming",
            sortOrder: 0,
            hardStop: 0,
            lowerThirdId: null,
            scheduledStart: null,
            expectedEnd: null,
            actualStart: null,
            actualEnd: null,
          }] as T[] : [] };
        }
        throw new Error(`Unhandled all query: ${sql}`);
      },
      async run() {
        throw new Error(`Unexpected write query: ${sql}`);
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

async function requestWorkspace(db: MobileApiDatabase) {
  const response = await handleMobileApi(
    new Request("https://showpilot.tech/api/mobile/v1/show-workspace?orgId=org-1"),
    { DB: db },
  );
  if (!response) throw new Error("Mobile API did not handle Show workspace route");
  return response;
}

describe("mobile Show workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Mobile Viewer", email: "viewer@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "viewer",
      permissions: ["show:view", "chat:access", "showboard:view", "rundown:view"],
    });
  });

  it("returns one tenant-scoped live workspace with its capabilities", async () => {
    const response = await requestWorkspace(fakeDatabase());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      clockFormat: "24hr",
      timeZone: "Africa/Accra",
      configuredAdapter: "native",
      adapterStatus: "ready",
      chatAvailable: true,
      showBoardAvailable: true,
      canOpenRundown: true,
      crew: [{ id: "crew-1", name: "Ada Director", isOnline: true }],
      runtime: {
        kind: "native",
        show: { id: "show-1", name: "Sunday Service" },
        items: [{ id: "item-1", title: "Welcome", hardStop: false }],
        timer: { playback: "play", currentItemId: "item-1" },
      },
    });
  });

  it("does not repopulate a stale past show when no current or upcoming show exists", async () => {
    const response = await requestWorkspace(fakeDatabase({ includeUpcomingShow: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: { kind: "native", show: null, items: [] },
    });
  });

  it("requires Show access instead of borrowing rundown or check-in access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "viewer", permissions: ["rundown:view", "checkin:access"] });

    const response = await requestWorkspace(fakeDatabase());

    expect(response.status).toBe(403);
  });
});
