// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiStatement,
} from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  relay: vi.fn(),
  showDeleting: false,
}));

vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("@/lib/effective-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../effective-access")>()),
  resolveEffectiveAccess: mocks.access,
}));
vi.mock("@/lib/crew-chat-pass", () => ({ verifyCrewChatPass: vi.fn() }));
vi.mock("@/lib/auth-origins", () => ({ isAllowedApiOrigin: () => true }));
vi.mock("@/durable-objects/ChatRelay", () => ({ ChatRelay: class {} }));
vi.mock("@/durable-objects/RundownRelay", () => ({ RundownRelay: class {} }));
vi.mock("@/durable-objects/TimecodeRelay", () => ({ TimecodeRelay: class {} }));
vi.mock("@/durable-objects/BridgeRelay", () => ({ BridgeRelay: class {} }));
vi.mock("@/durable-objects/LowerThirdsRelay", () => ({ LowerThirdsRelay: class {} }));
vi.mock("@/durable-objects/CueSheetRelay", () => ({ CueSheetRelay: class {} }));

import server from "../../server";

function database(): MobileApiDatabase {
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.includes("SELECT r.id FROM rundown r")) {
          return (mocks.showDeleting ? null : { id: "show-1" }) as T;
        }
        if (sql.includes("key = ? LIMIT 1") && params[1] === "rundown-pin") return { value: "2468" } as T;
        if (sql.includes("FROM rundown WHERE id = ?")) {
          return {
            id: "show-1",
            serviceDate: "2026-09-21",
            name: "Sunday Service",
            scheduledStartTime: "2026-09-21T14:00:00.000Z",
            scheduledCallTime: null,
            location: "Auditorium",
            status: "upcoming",
            updatedAt: "2026-09-21T12:00:00.000Z",
          } as T;
        }
        if (sql.startsWith("SELECT id FROM rundown WHERE orgId")) return { id: "show-1" } as T;
        if (sql.includes("key = 'org-timezone'")) return { value: "UTC" } as T;
        return null;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
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

describe("rundown PIN boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "tm-1", name: "Technical Manager", email: "tm@example.com" } });
    mocks.access.mockResolvedValue({
      role: "tm",
      permissions: ["show:view", "rundown:view"],
      grantedPermissions: [],
      revision: "",
      today: "2026-09-21",
    });
    mocks.relay.mockResolvedValue(new Response("forwarded"));
    mocks.showDeleting = false;
  });

  it("challenges mobile rundown reads until the correct PIN is supplied", async () => {
    const db = database();
    const missing = await handleMobileApi(
      new Request("https://showpilot.test/api/mobile/v1/rundowns/show-1?orgId=org-1"),
      { DB: db },
    );
    expect(missing?.status).toBe(401);
    await expect(missing?.json()).resolves.toMatchObject({ error: "pin_required" });

    const wrong = await handleMobileApi(
      new Request("https://showpilot.test/api/mobile/v1/rundowns/show-1?orgId=org-1", {
        headers: { "x-showpilot-rundown-pin": "0000" },
      }),
      { DB: db },
    );
    expect(wrong?.status).toBe(401);

    const valid = await handleMobileApi(
      new Request("https://showpilot.test/api/mobile/v1/rundowns/show-1?orgId=org-1", {
        headers: { "x-showpilot-rundown-pin": "2468" },
      }),
      { DB: db },
    );
    expect(valid?.status).toBe(200);
    await expect(valid?.json()).resolves.toMatchObject({ show: { id: "show-1" } });
  });

  it("does not forward a protected live relay connection without the PIN", async () => {
    const db = database();
    const env = {
      DB: db,
      RUNDOWN_RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }) },
    };
    const path = "https://showpilot.test/api/rundown/org-1/ws?serviceDate=2026-09-21&showId=show-1";

    const missing = await server.fetch(new Request(path), env, {});
    expect(missing.status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();

    const valid = await server.fetch(new Request(path, {
      headers: { "x-showpilot-rundown-pin": "2468" },
    }), env, {});
    expect(valid.status).toBe(200);
    expect(mocks.relay).toHaveBeenCalledOnce();
  });

  it("does not forward a deleted or tombstoned show's old relay URL", async () => {
    mocks.showDeleting = true;
    const db = database();
    const response = await server.fetch(new Request(
      "https://showpilot.test/api/rundown/org-1/state?serviceDate=2026-09-21&showId=show-1&display=1",
    ), {
      DB: db,
      RUNDOWN_RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }) },
    }, {});
    expect(response.status).toBe(404);
    expect(mocks.relay).not.toHaveBeenCalled();
  });
});
