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

function database(cuesEnabled = true, writes: unknown[][] = []): MobileApiDatabase {
  function statement(sql: string, bound: unknown[] = []): MobileApiStatement {
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
            { key: "propresenter-stage-display", value: "false" },
          ] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("INSERT INTO app_setting")) writes.push(bound);
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...values) => statement(sql, values) };
    },
    async batch(statements) {
      return Promise.all(statements.map((candidate) => candidate.run()));
    },
  };
}

function environment(cuesEnabled = true, writes: unknown[][] = []) {
  const dispatchBridgeMessage = vi.fn(async () => ({ success: true }));
  const recoverProPresenterCommand = vi.fn(async (input: Record<string, unknown>) => {
    if (!cuesEnabled) throw new Error("Cue control is disabled");
    return { ...input, status: "prepared", message: "Slide command ready." };
  });
  const bridge = {
    idFromName: vi.fn(() => ({ toString: () => "bridge-room" })),
    get: vi.fn(() => ({
      getBridgeStatus: vi.fn(async () => ({
        bridgeOnline: true,
        clientCount: 0,
        connectedTargets: [],
      })),
      dispatchBridgeMessage, recoverProPresenterCommand,
    })),
  } as unknown as MobileApiEnvironment["BRIDGE_RELAY"];
  return {
    env: { DB: database(cuesEnabled, writes), BRIDGE_RELAY: bridge } satisfies MobileApiEnvironment,
    dispatchBridgeMessage, recoverProPresenterCommand,
  };
}

const scope = { orgId: "org-1", userId: "operator-1", showId: "show-1", requestId: "a31b4d77-7f9b-40cd-9119-4794980c0551" };
async function command(body: Record<string, unknown>, env: MobileApiEnvironment) {
  const response = await handleMobileApi(new Request(
    "https://showpilot.tech/api/mobile/v1/rundowns/show-1/propresenter/prepare?orgId=org-1",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...scope, ...body }),
    },
  ), env);
  if (!response) throw new Error("Mobile API did not handle ProPresenter route");
  return response;
}

async function stageDisplay(body: Record<string, unknown>, env: MobileApiEnvironment) {
  const response = await handleMobileApi(new Request(
    "https://showpilot.tech/api/mobile/v1/rundowns/show-1/propresenter/stage-display?orgId=org-1",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ), env);
  if (!response) throw new Error("Mobile API did not handle ProPresenter stage-display route");
  return response;
}

describe("mobile ProPresenter control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "operator-1", name: "Operator", email: "operator@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "tm", permissions: ["rundown:control"], today: "2026-08-27" });
  });

  it("delegates the original command and live session to the org-scoped receipt authority", async () => {
    const { env, dispatchBridgeMessage, recoverProPresenterCommand } = environment();
    const response = await command({ command: "next" }, env);
    expect(response.status).toBe(200);
    expect(recoverProPresenterCommand).toHaveBeenCalledWith({ ...scope, command: "next" }, {
      orgId: "org-1", userId: "operator-1", sessionId: "session-1", rundownPin: null,
    }, "prepare");
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });

  it("rejects commands outside the remote-control allowlist", async () => {
    const { env, dispatchBridgeMessage } = environment();
    const response = await command({ command: "delete-library" }, env);

    expect(response.status).toBe(400);
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });

  it("does not report success when the relay rejects preparation", async () => {
    const { env, dispatchBridgeMessage } = environment(false);
    const response = await command({ command: "clear" }, env);

    expect(response.status).toBe(503);
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });

  it("rejects the old stage-display endpoint with an update-required response", async () => {
    const writes: unknown[][] = [];
    const { env, dispatchBridgeMessage } = environment(true, writes);
    for (const enabled of [true, false, "yes"]) {
      const response = await stageDisplay({ enabled }, env);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Update the app before changing ProPresenter output." });
    }
    expect(writes).toHaveLength(0);
    expect(dispatchBridgeMessage).not.toHaveBeenCalled();
  });
});
