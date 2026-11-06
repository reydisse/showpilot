import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoredDeviceModule } from "../stored-device-module";
import type { RemoteControlDefinition } from "../device-modules/types";
const bridge = vi.hoisted(() => ({
  event: null as ((target: string, eventName: string, data: string) => void) | null,
  status: null as ((target: string, connected: boolean) => void) | null,
}));
vi.mock("../device-modules/bridge-proxy", () => ({ getSharedBridgeProxy: () => ({
  onDeviceStatus: (listener: typeof bridge.status) => { bridge.status = listener; return () => { bridge.status = null; }; },
  onDeviceEvent: (listener: typeof bridge.event) => { bridge.event = listener; return () => { bridge.event = null; }; },
}) }));
const remote: RemoteControlDefinition = {
  protocol: "http-command", target: () => "http://fixture:80", actions: () => [], feedbacks: () => [{ id: "state", label: "State", type: "string", value: null }],
  buildCommand: () => { throw new Error("The browser must not build saved-device commands."); },
  parseEvent: (_event, data) => ({ state: data }),
};
const state = { connected: true, bridgeOnline: true, controls: [{ id: "turn_on", label: "Turn on", category: "Lights", params: [] }], feedbacks: [{ id: "state", label: "State", type: "string", value: "on", available: true }] };
const modules: StoredDeviceModule[] = [];
function fixture() { const module = new StoredDeviceModule("org-a", "device-a", remote, { password: "••••••••" }); modules.push(module); return module; }
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => Response.json(init.method === "GET" ? state : { success: true })));
});
afterEach(() => { modules.splice(0).forEach(module => module.disconnect()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("controls by ID, refreshes discovered actions and receives immediate event feedback without transmitting the mask", async () => {
  const module = fixture();
  const feedback = vi.fn(); module.onFeedbackChange(feedback);
  await module.connect();
  expect(module.connectionStatus()).toBe("connected");
  expect(module.getActions()).toEqual(state.controls);
  bridge.event?.("http://fixture:80", "state", "off");
  expect(feedback).toHaveBeenLastCalledWith("state", "off");
  await module.executeAction("turn_on", { entityId: "light.room" });
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.every(([url]) => url === "/api/mobile/v1/devices/device-a/control?orgId=org-a")).toBe(true);
  expect(calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { operation: "connect" }, { operation: "action", actionId: "turn_on", params: { entityId: "light.room" } },
  ]);
  expect(JSON.stringify(calls)).not.toContain("••••••••");
});

it("detaches on unmount without disconnecting a shared venue device; explicit Disconnect sends an operation", async () => {
  const module = fixture(); await module.connect();
  module.disconnect();
  const count = vi.mocked(fetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(count);
  expect(bridge.event).toBeNull();
  expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain('"operation":"disconnect"');
  await module.connect();
  await module.disconnectDevice();
  expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual({ operation: "disconnect" });
});

it("ignores a late response after detach and reports denied actions", async () => {
  const module = fixture();
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = module.connect();
  module.disconnect();
  finish(Response.json({ success: true }));
  await pending;
  expect(module.connectionStatus()).toBe("disconnected");
  await module.connect();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Destination approval was removed." }, { status: 403 }));
  await expect(module.executeAction("turn_on", {})).rejects.toThrow("Destination approval was removed.");
});

it("reports status polling failures without claiming the device is connected and permits retry", async () => {
  const module = fixture(); await module.connect();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Access revoked" }, { status: 403 }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(module.connectionStatus()).toBe("error");
  await module.connect();
  expect(module.connectionStatus()).toBe("connected");
});

it("pauses status requests in hidden tabs and serializes a new connection after an explicit disconnect", async () => {
  const module = fixture(); await module.connect();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const count = vi.mocked(fetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(fetch).toHaveBeenCalledTimes(count);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledTimes(count + 1);
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const disconnect = module.disconnectDevice();
  const reconnect = module.connect();
  expect(JSON.parse(String(vi.mocked(fetch).mock.lastCall?.[1]?.body))).toEqual({ operation: "disconnect" });
  finish(Response.json({ success: true }));
  await disconnect;
  await reconnect;
  expect(module.connectionStatus()).toBe("connected");
});
