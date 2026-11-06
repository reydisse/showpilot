// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { displayCookieName, issueDisplayPass } from "../display-access.server";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), relay: vi.fn(), target: vi.fn(), bindShow: vi.fn(), room: vi.fn() }));
vi.mock("../timecode-target.server", async (original) => ({ ...await original<typeof import("../timecode-target.server")>(), resolveTimecodeTarget: mocks.target }));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("../effective-access", async (original) => ({ ...await original<typeof import("../effective-access")>(), resolveEffectiveAccess: mocks.access }));
vi.mock("@/durable-objects/ChatRelay", () => ({ ChatRelay: class {} }));
vi.mock("@/durable-objects/RundownRelay", () => ({ RundownRelay: class {} }));
vi.mock("@/durable-objects/TimecodeRelay", () => ({ TimecodeRelay: class {} }));
vi.mock("@/durable-objects/BridgeRelay", () => ({ BridgeRelay: class {} }));
vi.mock("@/durable-objects/LowerThirdsRelay", () => ({ LowerThirdsRelay: class {} }));
vi.mock("@/durable-objects/CueSheetRelay", () => ({ CueSheetRelay: class {} }));
import server from "../../server";
const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }), getByName: mocks.room };
const bindings = {
  DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("FROM organization") ? { id: "org-1" } : null, run: async () => ({ success: true }) }) }) },
  RUNDOWN_RELAY: namespace, TIMECODE_RELAY: namespace, LOWER_THIRDS_RELAY: namespace,
  BRIDGE_RELAY: namespace, CHAT_RELAY: namespace, CUE_SHEET_RELAY: namespace,
  BETTER_AUTH_SECRET: "gateway-internal-fixture-secret",
  KIOSK_SECRET: "display-gateway-fixture-secret",
};
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue(null); mocks.relay.mockResolvedValue(new Response("Display fixture"));
  mocks.target.mockResolvedValue({ orgId: "org-1", showId: "show-1", serviceDate: "2026-11-05" });
  mocks.bindShow.mockResolvedValue({ ok: true });
  mocks.room.mockReturnValue({ fetch: mocks.relay, bindShow: mocks.bindShow });
});

describe("public display Worker boundary", () => {
  function signedInOperator() {
    mocks.session.mockResolvedValue({ user: { id: "real-operator", name: "Fixture operator" }, session: { id: "real-session" } });
    mocks.access.mockResolvedValue({ role: "owner", permissions: [
      "timecode:access", "rundown:control", "rundown:edit", "rundown:view", "show:view",
      "devices:access", "lowerthird:trigger", "chat:access", "cuesheet:view", "cuesheet:edit", "incidents:access",
    ] });
  }

  it.each(["timecode", "rundown", "bridge", "chat", "cue-sheet", "lowerthirds"])("never forwards an operator's %s maintenance request", async relay => {
    signedInOperator();
    const response = await server.fetch(new Request(`https://app.example/api/${relay}/org-1/internal/purge-org`, {
      method: "POST", headers: { "x-showpilot-internal-secret": "forged" },
    }), bindings, {});
    expect(response.status).toBe(404);
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it.each(["timecode", "rundown", "chat", "cue-sheet", "lowerthirds"])("rebuilds a member's %s URL without caller-supplied authority or unused query fields", async relay => {
    signedInOperator();
    const response = await server.fetch(new Request(`https://app.example/api/${relay}/org-1/ws?authUserId=forged&authSessionId=forged&authExtra=forged&access=forged&role=forged&key=forged&unused=private`), bindings, {});
    expect(response.status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    const query = new URL(forwarded.url).searchParams;
    expect(query.get("authUserId")).toBe("real-operator");
    expect(query.get("authSessionId")).toBe("real-session");
    for (const field of ["authExtra", "key", "unused"]) expect(query.has(field)).toBe(false);
    expect(query.get("role")).toBe(relay === "chat" ? "owner" : null);
    expect(query.get("access")).not.toBe("forged");
  });

  it("preserves only the supported chat-history cursor parameters", async () => {
    signedInOperator();
    await server.fetch(new Request("https://app.example/api/chat/org-1/history?limit=30&beforeTimestamp=123&beforeId=message-1&key=forged"), bindings, {});
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    const query = new URL(forwarded.url).searchParams;
    expect(query.get("limit")).toBe("30");
    expect(query.get("beforeTimestamp")).toBe("123");
    expect(query.get("beforeId")).toBe("message-1");
    expect(query.has("key")).toBe(false);
  });

  it.each(["rundown", "timecode"])("rejects anonymous %s display reads and forged internal claims", async (relay) => {
    const response = await server.fetch(new Request(`https://app.example/api/${relay}/org-1/state?display=1&authUserId=owner&authSessionId=fake&authDisplayExpiresAt=9999999999999`), bindings, {});
    expect(response.status).toBe(401); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it.each(["rundown", "timecode"])("passes only read-only %s projection authority to the DO", async (relay) => {
    const pass = await issueDisplayPass("org-1", "timer", bindings.KIOSK_SECRET);
    const request = new Request(`https://app.example/api/${relay}/org-1/state?display=1&access=write&authUserId=forged&authSessionId=forged&authDisplayExpiresAt=9999999999999`, { headers: { cookie: `${displayCookieName("org-1", "timer")}=${pass.token}` } });
    expect((await server.fetch(request, bindings, {})).status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    expect(Object.fromEntries(new URL(forwarded.url).searchParams)).toEqual({ orgId: "org-1", access: "read", authDisplayExpiresAt: String(pass.authority.expiresAt), ...(relay === "timecode" ? { showId: "show-1", serviceDate: "2026-11-05" } : {}) });
    expect(forwarded.url).not.toContain(pass.token);
  });
  it("cannot use a display pass for commands or a different surface", async () => {
    const pass = await issueDisplayPass("org-1", "overlay", bindings.KIOSK_SECRET);
    const headers = { "x-showpilot-display-pass": pass.token };
    for (const relay of ["rundown", "timecode"]) {
      expect((await server.fetch(new Request(`https://app.example/api/${relay}/org-1/state?display=1`, { headers }), bindings, {})).status).toBe(401);
      expect((await server.fetch(new Request(`https://app.example/api/${relay}/org-1/command`, { headers, method: "POST", body: "{}" }), bindings, {})).status).toBe(401);
    }
    expect((await server.fetch(new Request("https://app.example/api/lowerthirds/org-1/trigger", { headers, method: "POST", body: "{}" }), bindings, {})).status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("gates lower-third reads as well as the overlay API", async () => {
    const url = "https://app.example/api/lowerthirds/org-1/current";
    expect((await server.fetch(new Request(url), bindings, {})).status).toBe(401);
    const pass = await issueDisplayPass("org-1", "overlay", bindings.KIOSK_SECRET);
    expect((await server.fetch(new Request(url, { headers: { "x-showpilot-display-pass": pass.token } }), bindings, {})).status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    expect(new URL(forwarded.url).searchParams.get("access")).toBe("read");
  });
  it("selects the exact timecode room and never forwards a public internal path", async () => {
    const pass = await issueDisplayPass("org-1", "timer", bindings.KIOSK_SECRET);
    const headers = { "x-showpilot-display-pass": pass.token };
    const response = await server.fetch(new Request("https://app.example/api/timecode/org-1/state?display=1&showId=show-1&authOther=forged&role=bridge&key=forged", { headers }), bindings, {});
    expect(response.status).toBe(200);
    expect(mocks.target).toHaveBeenCalledWith(bindings.DB, "org-1", "show-1");
    expect(mocks.room).toHaveBeenCalledWith("org-1:show:show-1");
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    for (const key of ["authOther", "role", "key"]) expect(new URL(forwarded.url).searchParams.has(key)).toBe(false);
    expect((await server.fetch(new Request("https://app.example/api/timecode/org-1/internal/bridge-feed", { method: "POST", headers }), bindings, {})).status).toBe(404);
    mocks.target.mockResolvedValue(null);
    expect((await server.fetch(new Request("https://app.example/api/timecode/org-1/state?display=1&showId=missing", { headers }), bindings, {})).status).toBe(404);
  });

  it("requires member timecode permission for media outputs even with a valid display pass", async () => {
    const pass = await issueDisplayPass("org-1", "timer", bindings.KIOSK_SECRET);
    const headers = { "x-showpilot-display-pass": pass.token, Upgrade: "websocket" };
    const url = "https://app.example/api/timecode/org-1/media-ws?display=1&authUserId=forged&authSessionId=forged&access=write";
    expect((await server.fetch(new Request(url, { headers }), bindings, {})).status).toBe(401);
    signedInOperator();
    mocks.access.mockResolvedValue({ role: "member", permissions: ["rundown:read"] });
    expect((await server.fetch(new Request(url, { headers }), bindings, {})).status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();
    signedInOperator();
    expect((await server.fetch(new Request(url, { headers }), bindings, {})).status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    expect(new URL(forwarded.url).pathname).toBe("/media-ws");
    expect(Object.fromEntries(new URL(forwarded.url).searchParams)).toEqual({ orgId: "org-1", showId: "show-1", serviceDate: "2026-11-05", access: "write", authUserId: "real-operator", authSessionId: "real-session" });
  });
});
