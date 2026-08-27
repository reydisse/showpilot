import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMobileApi,
  type MobileApiDatabase,
  type MobileApiEnvironment,
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
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

function database(cuesEnabled = true): MobileApiDatabase {
  function statement(sql: string): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT id FROM rundown")) return { id: "show-1" } as T;
        return null;
      },
      async all<T>() {
        if (sql.includes("propresenter-host")) {
          return { results: [
            { key: "propresenter-host", value: "192.168.1.20" },
            { key: "propresenter-port", value: "50001" },
            { key: "propresenter-api-port", value: "1025" },
            { key: "propresenter-password", value: "venue-password" },
            { key: "propresenter-send-cues", value: String(cuesEnabled) },
          ] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: () => statement(sql) };
    },
    async batch(statements) {
      return Promise.all(statements.map((candidate) => candidate.run()));
    },
  };
}

function environment(cuesEnabled = true) {
  const dispatchBridgeMessage = vi.fn(async () => ({ success: true }));
  const bridge = {
    idFromName: vi.fn(() => ({ toString: () => "bridge-room" })),
    get: vi.fn(() => ({
      getBridgeStatus: vi.fn(async () => ({
        bridgeOnline: true,
        clientCount: 0,
        connectedTargets: [],
      })),
      dispatchBridgeMessage,
    })),
  } as unknown as MobileApiEnvironment["BRIDGE_RELAY"];
  return {
    env: { DB: database(cuesEnabled), BRIDGE_RELAY: bridge } satisfies MobileApiEnvironment,
    dispatchBridgeMessage,
  };
}

async function command(body: Record<string, unknown>, env: MobileApiEnvironment) {
  const response = await handleMobileApi(new Request(
    "https://showpilot.tech/api/mobile/v1/rundowns/show-1/propresenter?orgId=org-1",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ), env);
  if (!response) throw new Error("Mobile API did not handle ProPresenter route");
  return response;
}

describe("mobile ProPresenter control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "operator-1", name: "Operator", email: "operator@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "tm", permissions: ["rundown:control"], today: "2026-08-27" });
  });

  it("connects the configured venue target before dispatching an allowlisted command", async () => {
    const { env, dispatchBridgeMessage } = environment();
    const response = await command({ command: "next" }, env);

    expect(response.status).toBe(200);
    expect(dispatchBridgeMessage).toHaveBeenNthCalledWith(1, {
      type: "connect-device",
      protocol: "propresenter",
      target: "propresenter:192.168.1.20:50001",
      settings: {
        host: "192.168.1.20",
        port: 50001,
        apiPort: 1025,
        password: "venue-password",
      },
    });
    expect(dispatchBridgeMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "command",
      protocol: "propresenter",
      target: "propresenter:192.168.1.20:50001",
      command: "next",
    }));
  });

  it("rejects commands outside the remote-control allowlist", async () => {
    const { env, dispatchBridgeMessage } = environment();
    const response = await command({ command: "delete-library" }, env);

    expect(response.status).toBe(400);
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });

  it("honors the workspace cue-control safety setting", async () => {
    const { env, dispatchBridgeMessage } = environment(false);
    const response = await command({ command: "clear" }, env);

    expect(response.status).toBe(409);
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });
});
