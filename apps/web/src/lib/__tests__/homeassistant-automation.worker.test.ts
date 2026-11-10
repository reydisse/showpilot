import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { timecodeFixture, startFixtureTimecodeFeed } from "@/test/timecode-fixtures";
import { openTestBridge, approveTestBridgeTarget } from "@/test/bridge-fixtures";
import { writeDeviceSettings } from "../device-settings.server";
import type { AutomationEvent } from "@/types/timecode";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture", email: "fixture@example.test" } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { getAutomationDeviceTargets, getAutomationHomeAssistantActions } from "../automation-targets";

afterEach(abortAllDurableObjects);
const target = "http://192.0.2.80:8123";
const actionId = "ha:scene:turn_on:scene.service";
const entities = JSON.stringify([
  { entity_id: "scene.service", state: "scening", attributes: { friendly_name: "Service", private_fixture: "do-not-return" } },
  { entity_id: "lock.door", state: "locked" },
]);
const messageSchema = z.object({ type: z.string(), id: z.string().optional(), command: z.string().optional(),
  target: z.string().optional(), protocol: z.string().optional(), protectedSettings: z.unknown().optional() });

async function fixture() {
  const test = await timecodeFixture();
  auth.userId = test.authority.userId;
  const deviceId = crypto.randomUUID();
  const settings = await writeDeviceSettings(env.CREDENTIAL_ENCRYPTION_KEYS, { id: deviceId, orgId: test.orgId, adapterType: "homeassistant" }, JSON.stringify({ baseUrl: target, accessToken: "ha-fixture-private" }));
  await env.DB.prepare("INSERT INTO device(id,orgId,name,category,adapterType,settings,enabled,createdAt,updatedAt) VALUES (?,?,?,'automation','homeassistant',?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    .bind(deviceId, test.orgId, "Fixture Home Assistant", settings).run();
  await approveTestBridgeTarget(test.orgId, "http-command", target);
  const bridge = await openTestBridge(test.orgId);
  const wire = { commands: [] as string[], connections: [] as Record<string, unknown>[], errors: [] as unknown[], response: entities, success: true, serviceSuccess: true, hold: false, replies: [] as (() => void)[] };
  bridge.socket.addEventListener("message", event => { void (async () => {
    const message = messageSchema.parse(JSON.parse(String(event.data)));
    if (message.type === "connect-device") {
      wire.connections.push(await bridge.recipient.open(message.protectedSettings, { orgId: test.orgId, installationId: bridge.credential.installationId, protocol: "http-command", target }));
      bridge.socket.send(JSON.stringify({ type: "device-status", target, connected: true }));
    }
    if (message.type === "command" && message.command) {
      wire.commands.push(message.command);
      const discovery = message.command === "GET /api/states";
      const reply = () => bridge.socket.send(JSON.stringify({ type: "command-response", id: message.id,
        success: discovery ? wire.success : wire.serviceSuccess, response: discovery ? wire.response : "[]", ...(!wire.success && discovery ? { error: "Fixture discovery failed" } : {}), ...(!discovery && !wire.serviceSuccess ? { error: "Fixture service failed" } : {}) }));
      if (discovery && wire.hold) wire.replies.push(reply); else reply();
    }
  })().catch(error => wire.errors.push(error)); });
  const command = async (action: string, payload?: unknown) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    expect(response.status).toBe(200); await response.text();
  };
  const events = async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>();
  const prepare = async () => {
    await command("add-event", { id: "ha-cue", action: "device-action", targetDeviceId: deviceId, targetActionId: actionId,
      label: "Service scene", triggerTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, payload: { params: {}, untrusted: "do-not-forward" } });
    await startFixtureTimecodeFeed(test.stub, test.url);
  };
  const fire = () => command("feed-tc", { timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, format: { frameRate: 30, dropFrame: "ndf" } });
  const connect = async () => {
    bridge.socket.send(JSON.stringify({ type: "device-status", target, connected: true }));
    await expect.poll(async () => (await bridge.stub.getBridgeStatus()).connectedTargets).toContain(target);
  };
  return { ...test, bridge, wire, deviceId, command, events, prepare, fire, connect };
}

it("lists HA without connecting, discovers only the selected device and returns no configuration", async () => {
  const test = await fixture();
  expect(await getAutomationDeviceTargets({ data: { orgId: test.orgId } })).toEqual([
    { id: test.deviceId, label: "Fixture Home Assistant", category: "automation", actionSource: "homeassistant" },
  ]);
  expect(test.wire.commands).toEqual([]);
  await expect(getAutomationHomeAssistantActions({ data: { orgId: test.orgId, deviceId: test.deviceId } })).rejects.toThrow("Connect this Home Assistant device");
  expect(test.wire.connections).toEqual([]);
  await test.connect();
  const actions = await getAutomationHomeAssistantActions({ data: { orgId: test.orgId, deviceId: test.deviceId } });
  expect(actions).toEqual([{ id: actionId, label: "Service", category: "scenes", params: [] }]);
  for (const hidden of [target, "ha-fixture-private", "do-not-return", "lock.door", "settings"]) expect(JSON.stringify(actions)).not.toContain(hidden);
  expect(test.wire.commands).toEqual(["GET /api/states"]);
  await expect(getAutomationHomeAssistantActions({ data: { orgId: test.orgId, deviceId: "another-device" } })).rejects.toThrow("Choose an enabled");
  const other = await timecodeFixture();
  auth.userId = other.authority.userId;
  await expect(getAutomationHomeAssistantActions({ data: { orgId: test.orgId, deviceId: test.deviceId } })).rejects.toThrow("Forbidden");
  expect(test.wire.commands).toHaveLength(1);
});

it("fires only after encrypted connection, fresh discovery and service acknowledgement", async () => {
  const test = await fixture(); await test.prepare(); await test.fire();
  expect(test.wire.errors).toEqual([]);
  expect(test.wire.connections).toEqual([{ authToken: "ha-fixture-private" }]);
  expect(test.wire.commands).toEqual(["GET /api/states", 'POST /api/services/scene/turn_on {"entity_id":"scene.service"}']);
  expect(await test.events()).toEqual([expect.objectContaining({ id: "ha-cue", fired: true, executionStatus: "acknowledged" })]);
});

it.each([
  { label: "removed entity", response: "[]", success: true, error: "not available" },
  { label: "malformed JSON", response: "{broken", success: true, error: "unreadable" },
  { label: "invalid list", response: '{"error":"private"}', success: true, error: "invalid action list" },
  { label: "failed discovery", response: "[]", success: false, error: "Fixture discovery failed" },
])("keeps $label visibly failed without dispatching a service", async failure => {
  const test = await fixture(); test.wire.response = failure.response; test.wire.success = failure.success;
  await test.prepare(); await test.fire();
  expect(test.wire.commands).toEqual(["GET /api/states"]);
  expect(await test.events()).toEqual([expect.objectContaining({ fired: false, executionStatus: "failed", executionError: expect.stringContaining(failure.error) })]);
});

it("honors the kill switch while discovery is in flight", async () => {
  const test = await fixture(); test.wire.hold = true;
  await test.prepare(); const firing = test.fire();
  await expect.poll(() => test.wire.replies.length).toBe(1);
  await test.command("set-triggers-enabled", { enabled: false });
  test.wire.replies[0](); await firing;
  expect(test.wire.commands).toEqual(["GET /api/states"]);
  expect((await test.events())[0].fired).toBe(false);
});

it("keeps a rejected service visibly failed after successful discovery", async () => {
  const test = await fixture(); test.wire.serviceSuccess = false;
  await test.prepare(); await test.fire();
  expect(test.wire.commands).toEqual(["GET /api/states", 'POST /api/services/scene/turn_on {"entity_id":"scene.service"}']);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionError: "Fixture service failed" });
});

it("times out discovery and cannot dispatch a service from the late response", async () => {
  const test = await fixture(); test.wire.hold = true;
  await test.prepare(); const firing = test.fire();
  await expect.poll(() => test.wire.replies.length).toBe(1);
  await firing;
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionError: expect.stringMatching(/timed out|timeout/i) });
  test.wire.replies[0]();
  // A subsequent relay RPC drains the reply before inspecting dispatch/output.
  await test.bridge.stub.getBridgeStatus();
  expect(test.wire.commands).toEqual(["GET /api/states"]);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed" });
}, 15_000);

it("rejects an active Bridge change during discovery before sending the service", async () => {
  const test = await fixture(); const standby = await openTestBridge(test.orgId); test.wire.hold = true;
  await test.prepare(); const firing = test.fire();
  await expect.poll(() => test.wire.replies.length).toBe(1);
  await test.bridge.stub.selectInstallation({ orgId: test.orgId, installationId: standby.credential.installationId,
    expectedActiveInstallationId: test.bridge.credential.installationId, actorUserId: test.authority.userId });
  test.wire.replies[0](); await firing;
  expect(test.wire.commands).toEqual(["GET /api/states"]);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed" });
});
