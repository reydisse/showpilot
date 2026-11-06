// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), relay: vi.fn(), authenticate: vi.fn(), migrate: vi.fn() }));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("../effective-access", async (original) => ({ ...await original<typeof import("../effective-access")>(), resolveEffectiveAccess: mocks.access }));
vi.mock("../bridge-credentials.server", () => ({ authenticateBridgeRequest: mocks.authenticate, migrateLegacyBridgeInstallation: mocks.migrate }));
vi.mock("@/durable-objects/ChatRelay", () => ({ ChatRelay: class {} }));
vi.mock("@/durable-objects/RundownRelay", () => ({ RundownRelay: class {} }));
vi.mock("@/durable-objects/TimecodeRelay", () => ({ TimecodeRelay: class {} }));
vi.mock("@/durable-objects/BridgeRelay", () => ({ BridgeRelay: class {} }));
vi.mock("@/durable-objects/LowerThirdsRelay", () => ({ LowerThirdsRelay: class {} }));
vi.mock("@/durable-objects/CueSheetRelay", () => ({ CueSheetRelay: class {} }));
import server from "../../server";

const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }) };
const bindings = {
  DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("FROM organization") ? { id: "org-1" } : null }) }) },
  BRIDGE_RELAY: namespace, RUNDOWN_RELAY: namespace, TIMECODE_RELAY: namespace, LOWER_THIRDS_RELAY: namespace,
  BETTER_AUTH_SECRET: "local-fixture-internal-secret",
};
const key = "sp_fixture_only";
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue(null);
  mocks.authenticate.mockResolvedValue({ orgId: "org-1", installationId: "installation-1", credentialId: "credential-1", expiresAt: null });
  mocks.relay.mockResolvedValue(new Response("Forwarded"));
});
describe("Bridge credentials at the public Worker boundary", () => {
  it.each(["rundown", "timecode", "lowerthirds"])("does not authorize %s commands with a Bridge key", async (relay) => {
    const response = await server.fetch(new Request(`https://app.example/api/${relay}/org-1/command`, {
      method: "POST", headers: { "x-showpilot-api-key": key }, body: "{}",
    }), bindings, {});
    expect(response.status).toBe(401); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("does not turn a transport credential into a member socket", async () => {
    const response = await server.fetch(new Request("https://app.example/api/bridge/org-1/ws?role=client", { headers: { "x-showpilot-api-key": key } }), bindings, {});
    expect(response.status).toBe(401); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it.each(["key", "apiKey", "api-key", "api_key", "authBridgeKey"])("rejects the %s query alias even with a valid header", async (parameter) => {
    const response = await server.fetch(new Request(`https://app.example/api/bridge/org-1/ws?role=bridge&${parameter}=${key}`, { headers: { "x-showpilot-api-key": key } }), bindings, {});
    expect(response.status).toBe(401); expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("forwards only server-derived identity and strips secrets and forged claims", async () => {
    const response = await server.fetch(new Request("https://app.example/api/bridge/org-1/ws?role=bridge&authCredentialId=forged&authUserId=owner&authSessionId=forged&access=write", {
      headers: { "x-showpilot-api-key": key, authorization: "Bearer fixture", cookie: "fixture=private", "x-showpilot-internal-secret": "forged" },
    }), bindings, {});
    expect(response.status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    expect(Object.fromEntries(new URL(forwarded.url).searchParams)).toEqual({ orgId: "org-1", role: "bridge", authCredentialId: "credential-1" });
    expect(forwarded.headers.get("x-showpilot-internal-secret")).toBe(bindings.BETTER_AUTH_SECRET);
    for (const header of ["x-showpilot-api-key", "cookie", "authorization"]) expect(forwarded.headers.has(header)).toBe(false);
    expect(forwarded.url).not.toContain(key);
  });
  it("fails closed for invalid credentials and missing internal authentication", async () => {
    const request = new Request("https://app.example/api/bridge/org-1/ws?role=bridge", { headers: { "x-showpilot-api-key": key } });
    expect((await server.fetch(request, { ...bindings, BETTER_AUTH_SECRET: undefined }, {})).status).toBe(503);
    mocks.authenticate.mockResolvedValue(null);
    expect((await server.fetch(request, bindings, {})).status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();
  });
});
