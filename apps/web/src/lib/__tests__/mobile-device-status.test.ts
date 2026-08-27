import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRelay } from "../../durable-objects/BridgeRelay";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

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

function fakeDatabase(): MobileApiDatabase {
  function statement(sql: string): MobileApiStatement {
    return {
      async first<T>() {
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM device WHERE orgId = ?")) {
          return { results: [
            { id: "atem-1", name: "Main ATEM", category: "video", adapterType: "atem", enabled: 1, updatedAt: "2026-08-27", settings: JSON.stringify({ host: "10.0.0.20", port: 9910, password: "never-return-this" }) },
            { id: "wing-1", name: "FOH Wing", category: "mixer", adapterType: "osc-mixer", enabled: 1, updatedAt: "2026-08-27", settings: JSON.stringify({ host: "10.0.0.30", consoleName: "wing" }) },
            { id: "obs-1", name: "Streaming OBS", category: "streaming", adapterType: "obs", enabled: 1, updatedAt: "2026-08-27", settings: JSON.stringify({ host: "10.0.0.40", port: 4455 }) },
            { id: "disabled-atem", name: "Spare ATEM", category: "video", adapterType: "atem", enabled: 0, updatedAt: "2026-08-27", settings: JSON.stringify({ host: "10.0.0.50", port: 9910 }) },
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
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

function bridgeNamespace(status: Record<string, unknown>) {
  return {
    idFromName: vi.fn(() => ({ toString: () => "org-1" })),
    get: vi.fn(() => ({ getBridgeStatus: vi.fn().mockResolvedValue(status) })),
  } as unknown as DurableObjectNamespace<BridgeRelay>;
}

async function getDevices(bridge?: DurableObjectNamespace<BridgeRelay>) {
  const response = await handleMobileApi(
    new Request("https://showpilot.tech/api/mobile/v1/devices?orgId=org-1"),
    { DB: fakeDatabase(), BRIDGE_RELAY: bridge },
  );
  if (!response) throw new Error("Mobile API did not handle devices route");
  return response;
}

describe("mobile device status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "operator-1", name: "Ada", email: "ada@example.com" } });
    mocks.resolveAccess.mockResolvedValue({ role: "admin", permissions: ["devices:access"], today: "2026-08-27" });
  });

  it("derives truthful per-device connection state from the venue Bridge", async () => {
    const response = await getDevices(bridgeNamespace({
      bridgeOnline: true,
      clientCount: 2,
      version: "0.1.8",
      devices: 1,
      uptime: 600,
      connectedTargets: ["10.0.0.20:9910", "10.0.0.40:4455", "10.0.0.50:9910"],
    }));
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      bridge: { online: true, clientCount: 2, version: "0.1.8", deviceCount: 1, uptime: 600 },
      devices: [
        expect.objectContaining({ id: "atem-1", connected: true }),
        expect.objectContaining({ id: "wing-1", connected: false }),
        expect.objectContaining({ id: "obs-1", connected: true }),
        expect.objectContaining({ id: "disabled-atem", connected: false }),
      ],
    }));
    expect(JSON.stringify(payload)).not.toContain("never-return-this");
    expect(payload).not.toHaveProperty("connectedTargets");
  });

  it("reports Bridge unavailable without inventing a device connection", async () => {
    const response = await getDevices();
    expect(response.status).toBe(200);
    const payload = await response.json() as { bridge: { online: boolean }; devices: { connected: boolean }[] };
    expect(payload.bridge.online).toBe(false);
    expect(payload.devices.every((device) => !device.connected)).toBe(true);
  });

  it("requires effective device access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [], today: "2026-08-27" });
    const response = await getDevices();
    expect(response.status).toBe(403);
  });
});
