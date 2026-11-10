import { afterEach, describe, expect, it, vi } from "vitest";
import { homeAssistantAutomationActions } from "../homeassistant-automation.server";
import { resolveTimecodeDeviceAction } from "../timecode-device-actions";
import { moduleRegistry } from "../device-modules/registry";
import { profileToModuleDefinition } from "../device-modules/profiles/profile-registry";
import type { DeviceProfile } from "../device-modules/profiles/types";
import type { AutomationEvent } from "@/types/timecode";

interface DeviceRow {
  id: string; name: string; category: string; adapterType: string; settings: string; enabled: number;
}
function database(device: DeviceRow | null) {
  const unexpected = () => { throw new Error("Unexpected database operation in command resolution."); };
  const statement = {
    bind: vi.fn<D1PreparedStatement["bind"]>().mockReturnThis(),
    first: vi.fn<D1PreparedStatement["first"]>().mockResolvedValue(device),
    all: vi.fn(unexpected),
    run: vi.fn(unexpected),
    raw: vi.fn(unexpected),
  } satisfies D1PreparedStatement;
  const db = {
    prepare: vi.fn<D1Database["prepare"]>().mockReturnValue(statement),
    batch: vi.fn(unexpected), exec: vi.fn(unexpected),
    withSession: vi.fn(unexpected), dump: vi.fn(unexpected),
  } satisfies D1Database;
  return { db, statement };
}
interface Golden {
  name: string; adapterType: string; settings: Record<string, unknown>;
  actionId: string; params: Record<string, unknown>; protocol: string; target: string;
  command: string; connectionSettings: Record<string, unknown>;
}
// Literal wire expectations: do not derive these with the production builder.
const goldens: Golden[] = [
  { name: "Home Assistant scene", adapterType: "homeassistant", settings: { baseUrl: "http://ha.fixture:8123", accessToken: "fixture-token" },
    actionId: "ha:scene:turn_on:scene.service", params: {}, protocol: "http-command", target: "http://ha.fixture:8123",
    command: 'POST /api/services/scene/turn_on {"entity_id":"scene.service"}', connectionSettings: { authToken: "fixture-token" } },
  { name: "ATEM program input", adapterType: "atem", settings: { host: "192.0.2.10", port: 9910 },
    actionId: "set_program_input", params: { input: "4" }, protocol: "atem", target: "192.0.2.10:9910",
    command: '{"actionId":"set_program_input","params":{"input":4}}', connectionSettings: { host: "192.0.2.10", port: 9910 } },
  { name: "Art-Net channel", adapterType: "dmx-artnet", settings: { host: "192.0.2.11", universe: 0 },
    actionId: "set_channel", params: { channel: 512, value: 255 }, protocol: "dmx-artnet", target: "192.0.2.11:6454",
    command: '{"actionId":"set_channel","params":{"channel":512,"value":255}}', connectionSettings: { host: "192.0.2.11", universe: 0 } },
  { name: "sACN multicast channel", adapterType: "dmx-sacn", settings: { universe: 258 },
    actionId: "set_channel", params: { channel: 1, value: 0 }, protocol: "dmx-sacn", target: "239.255.1.2:5568",
    command: '{"actionId":"set_channel","params":{"channel":1,"value":0}}', connectionSettings: { universe: 258 } },
  { name: "PJLink HDMI input", adapterType: "profile:epson-eb-l1755u", settings: { host: "192.0.2.12" },
    actionId: "set_input", params: { input: "hdmi2" }, protocol: "pjlink", target: "192.0.2.12:4352",
    command: "%1INPT 32\r", connectionSettings: { host: "192.0.2.12", port: 4352 } },
  { name: "VISCA preset in hexadecimal", adapterType: "profile:ptzoptics-move-4k", settings: { host: "192.0.2.13", viscaMode: "raw" },
    actionId: "recall_preset", params: { preset: 10 }, protocol: "visca-ip", target: "192.0.2.13:1259",
    command: "81 01 04 3F 02 0A FF", connectionSettings: { host: "192.0.2.13", port: 1259, cameraAddress: 1, viscaMode: "raw" } },
  { name: "TCP crosspoint routing", adapterType: "profile:extron-dxp-crosspoint", settings: { host: "192.0.2.14" },
    actionId: "route", params: { input: 3, output: 12 }, protocol: "tcp-command", target: "192.0.2.14:23",
    command: "3*12!\r\n", connectionSettings: { host: "192.0.2.14", port: 23, lineTerminator: "\r\n" } },
];
function resolve(golden: Golden, payloadStyle: "explicit" | "legacy" = "explicit") {
  const row = { id: "fixture-device", name: golden.name, category: "video", adapterType: golden.adapterType, settings: JSON.stringify(golden.settings), enabled: 1 };
  const fixture = database(row);
  const event: Pick<AutomationEvent, "action" | "payload" | "targetDeviceId" | "targetActionId"> = payloadStyle === "explicit"
    ? { action: "device-action", targetDeviceId: row.id, targetActionId: golden.actionId, payload: { params: golden.params } }
    : { action: "device-action", payload: { deviceId: row.id, actionId: golden.actionId, ...golden.params } };
  const discovery = vi.fn(async () => homeAssistantAutomationActions('[{"entity_id":"scene.service","state":"scening","attributes":{"friendly_name":"Service"}}]'));
  return { ...fixture, discovery, result: resolveTimecodeDeviceAction(fixture.db, "fixture-org", event, undefined, discovery) };
}
afterEach(() => vi.restoreAllMocks());
describe("timecode device command goldens", () => {
  for (const payloadStyle of ["explicit", "legacy"] as const) {
    it.each(goldens)(`${payloadStyle}: $name reaches its real command builder`, async golden => {
      const { result, db, statement, discovery } = resolve(golden, payloadStyle);
      await expect(result).resolves.toEqual({ deviceId: "fixture-device", deviceName: golden.name,
        protocol: golden.protocol, target: golden.target, command: golden.command, connectionSettings: golden.connectionSettings });
      expect(db.prepare).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/WHERE id = \? AND orgId = \?/));
      expect(statement.bind).toHaveBeenCalledExactlyOnceWith("fixture-device", "fixture-org");
      expect(statement.first).toHaveBeenCalledOnce();
      if (golden.adapterType === "homeassistant") expect(discovery).toHaveBeenCalledExactlyOnceWith({ deviceId: "fixture-device", deviceName: golden.name,
        protocol: golden.protocol, target: golden.target, connectionSettings: golden.connectionSettings });
      else expect(discovery).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled(); expect(statement.run).not.toHaveBeenCalled();
    });
  }

  it.each([
    { index: 1, params: { input: -1 } },
    { index: 2, params: { channel: 513, value: 0 } },
    { index: 3, params: { channel: 1, value: 256 } },
    { index: 4, params: { input: "serial" } },
    { index: 5, params: { preset: 255 } },
    { index: 6, params: { input: 3.5, output: 1 } },
  ])("rejects invalid command parameters for golden $index", async ({ index, params }) => {
    await expect(resolve({ ...goldens[index], params }).result).rejects.toThrow();
  });

  it.each([null, { id: "fixture-device", name: "Disabled", category: "video", adapterType: "atem", settings: "{}", enabled: 0 }])(
    "rejects missing or disabled rows before building any command", async row => {
      const { db, statement } = database(row);
      await expect(resolveTimecodeDeviceAction(db, "fixture-org", { action: "device-action", targetDeviceId: "fixture-device", targetActionId: "cut", payload: {} }))
        .rejects.toThrow("does not exist or is disabled");
      expect(statement.bind).toHaveBeenCalledWith("fixture-device", "fixture-org");
    },
  );

  it("rejects unknown actions and invalid connection settings", async () => {
    await expect(resolve({ ...goldens[1], actionId: "arbitrary-command" }).result).rejects.toThrow("not available");
    await expect(resolve({ ...goldens[1], settings: { host: "192.0.2.10", port: 65536 } }).result).rejects.toThrow("does not support remote control");
  });

  it("lets explicit event routing win without leaking legacy routing keys into parameters", async () => {
    const row = { id: "fixture-device", name: "ATEM", category: "video", adapterType: "atem", settings: JSON.stringify(goldens[1].settings), enabled: 1 };
    const { db, statement } = database(row);
    const result = await resolveTimecodeDeviceAction(db, "fixture-org", { action: "device-action", targetDeviceId: row.id,
      targetActionId: "set_program_input", payload: { deviceId: "other-device", targetDeviceId: "another-device", actionId: "cut", targetActionId: "auto", input: 3 } });
    expect(statement.bind).toHaveBeenCalledExactlyOnceWith("fixture-device", "fixture-org");
    expect(result.command).toBe('{"actionId":"set_program_input","params":{"input":3}}');
  });

  it("builds a WoL profile through the same resolver and registered protocol", async () => {
    // No built-in device profile uses WoL. Exercise the actual supported profile
    // registration path with a fixture, without adding a fictitious product.
    const profile: DeviceProfile = { profileVersion: 1, id: "fixture-wol", manufacturer: "Fixture", model: "Wake target",
      category: "video", icon: "Power", description: "Test-only WoL profile", protocol: "wol", feedbacks: [],
      actions: [{ id: "wake", label: "Wake", category: "power", params: [], mapping: { command: "AA:BB:CC:DD:EE:FF" } }] };
    moduleRegistry.register(profileToModuleDefinition(profile));
    const golden: Golden = { name: "WoL", adapterType: "profile:fixture-wol", settings: { mac: "AA:BB:CC:DD:EE:FF", broadcastAddress: "192.0.2.255" },
      actionId: "wake", params: {}, protocol: "wol", target: "wol", command: "AA:BB:CC:DD:EE:FF", connectionSettings: { mac: "AA:BB:CC:DD:EE:FF", broadcastAddress: "192.0.2.255" } };
    await expect(resolve(golden).result).resolves.toMatchObject({ protocol: golden.protocol, target: golden.target, command: golden.command, connectionSettings: golden.connectionSettings });
  });
});
