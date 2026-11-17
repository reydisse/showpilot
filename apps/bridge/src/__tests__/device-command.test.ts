import { describe, expect, it } from "vitest";
import { DEVICE_COMMAND_SCHEMA_VERSION, parseDeviceCommand } from "@showpilot/shared/device-command";
import { BRIDGE_TARGET_PROTOCOLS } from "@showpilot/shared/bridge-target";

const frame = { type: "command", id: "test", protocol: "osc", target: "10.0.0.1:8000", command: "/go" };

describe("device command schema", () => {
  it("preserves exactly the five wire fields", () => {
    expect(DEVICE_COMMAND_SCHEMA_VERSION).toBe(1);
    expect(parseDeviceCommand(frame)).toEqual(frame);
    expect(parseDeviceCommand({ ...frame, unknown: true })).toEqual(frame);
    expect(parseDeviceCommand({ ...frame, settings: { password: "secret" } })).toEqual(frame);
    expect(parseDeviceCommand({ type: "command", id: "", protocol: "", target: "", command: "" }))
      .toEqual({ type: "command", id: "", protocol: "", target: "", command: "" });
  });
  it("rejects missing fields and malformed frames", () => {
    for (const field of Object.keys(frame)) {
      const value: Record<string, unknown> = { ...frame };
      delete value[field];
      expect(parseDeviceCommand(value)).toBeNull();
    }
    for (const value of [null, undefined, 1, "command", [], { ...frame, id: 1 },
      { ...frame, target: null }, { ...frame, command: {} }, { ...frame, protocol: false }, { ...frame, type: "ping" }]) {
      expect(parseDeviceCommand(value)).toBeNull();
    }
  });
  it("defaults to v1 and rejects unsupported explicit versions", () => {
    expect(parseDeviceCommand(frame)).toEqual(frame);
    expect(parseDeviceCommand({ ...frame, v: undefined })).toEqual(frame);
    expect(parseDeviceCommand({ ...frame, v: 1 })).toEqual(frame);
    expect(parseDeviceCommand({ ...frame, v: 2 })).toBeNull();
    expect(parseDeviceCommand({ ...frame, v: "1" })).toBeNull();
  });
  const commands: Record<string, string> = {
    atem: '{"actionId":"set_program_input","params":{"input":1}}',
    obs: '{"actionId":"set_current_program_scene","params":{"sceneName":"Program"}}',
    "dmx-artnet": '{"actionId":"set_channel","params":{"channel":1,"value":255}}',
    "dmx-sacn": '{"actionId":"set_channel","params":{"channel":1,"value":255}}',
    osc: "/ch/01/mix/on i:1", pjlink: "%1POWR 1\r", propresenter: "next",
    "tcp-command": "POWER ON\r", udp: "go", "http-command": "GET /api/?Function=ActiveInput&Input=1",
    "visca-ip": "81 01 04 3F 02 01 FF", wol: "AA:BB:CC:DD:EE:FF",
  };
  it.each(BRIDGE_TARGET_PROTOCOLS)("accepts a golden %s frame", (protocol) => {
    const value = { ...frame, protocol, command: commands[protocol] };
    expect(parseDeviceCommand(value)).toEqual(value);
  });
});
