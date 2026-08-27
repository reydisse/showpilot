import { describe, expect, it } from "vitest";
import { buildHomeAssistantActions, buildHomeAssistantCommand, parseHomeAssistantEntities } from "../homeassistant/homeassistant-module";
import { resolveRemoteDeviceControl } from "../../mobile-device-controls";

const settingsByAdapter: Record<string, Record<string, unknown>> = {
  "atem": { host: "10.0.0.20", port: 9910 },
  "dmx-artnet": { host: "10.0.0.21", universe: 0 },
  "dmx-sacn": { universe: 1 },
  "homeassistant": { baseUrl: "http://homeassistant.local:8123", accessToken: "test-token" },
  "obs": { host: "10.0.0.22", port: 4455 },
  "osc-mixer": { host: "10.0.0.23", consoleName: "x32" },
  "profile:epson-eb-l1755u": { host: "10.0.0.24", port: 4352 },
  "profile:extron-dxp-crosspoint": { host: "10.0.0.25", port: 23 },
  "profile:panasonic-pt-rz690": { host: "10.0.0.26", port: 4352 },
  "profile:ptzoptics-move-4k": { host: "10.0.0.27", port: 52381 },
  "profile:samsung-smart-signage": { host: "10.0.0.28", port: 8001 },
  "vmix": { host: "10.0.0.29", port: 8088 },
};

function remote(adapterType: string) {
  const control = resolveRemoteDeviceControl(adapterType, settingsByAdapter[adapterType] ?? {});
  if (!control) throw new Error(`Missing remote contract for ${adapterType}`);
  return control;
}

describe("remote device-control contracts", () => {
  it("resolves every native-capable adapter to a Bridge protocol and typed action catalog", () => {
    for (const [adapterType, settings] of Object.entries(settingsByAdapter)) {
      const remote = resolveRemoteDeviceControl(adapterType, settings);
      expect(remote, adapterType).not.toBeNull();
      expect(remote?.target.length, adapterType).toBeGreaterThan(0);
      for (const action of remote?.actions ?? []) {
        expect(action.category, `${adapterType}:${action.id}`).not.toBe("");
        for (const param of action.params) {
          expect(["number", "boolean", "string", "select"], `${adapterType}:${action.id}:${param.id}`)
            .toContain(param.type);
        }
      }
    }
  });

  it("builds allowlisted commands for ATEM, OBS, DMX, mixer, and vMix", () => {
    const atem = remote("atem");
    expect(JSON.parse(atem.definition.buildCommand("set_program_input", { input: "4" }, {})))
      .toEqual({ actionId: "set_program_input", params: { input: 4 } });

    const obs = remote("obs");
    expect(JSON.parse(obs.definition.buildCommand("set_current_program_scene", { sceneName: "Program" }, {})))
      .toEqual({ actionId: "set_current_program_scene", params: { sceneName: "Program" } });
    expect(obs.definition.parseEvent?.("obs-state", JSON.stringify({
      currentProgramScene: "Program",
      streamingActive: true,
      scenes: ["Program", "Lobby"],
    }), {})).toEqual({
      current_program_scene: "Program",
      streaming_active: true,
      scene_list: JSON.stringify(["Program", "Lobby"]),
    });

    const dmx = remote("dmx-artnet");
    expect(JSON.parse(dmx.definition.buildCommand("set_channel", { channel: 12, value: 255 }, {})))
      .toEqual({ actionId: "set_channel", params: { channel: 12, value: 255 } });
    expect(dmx.definition.parseEvent?.("dmx-state", JSON.stringify({
      activeScene: "service",
      blackoutActive: false,
      masterLevel: 80,
    }), {})).toEqual({ active_scene: "service", blackout_active: false, master_level: 80 });

    const mixer = remote("osc-mixer");
    expect(mixer.definition.buildCommand("mute_channel", { channel: 2, muted: true }, settingsByAdapter["osc-mixer"]))
      .toBe("/ch/02/mix/on i:0");

    const vmix = remote("vmix");
    expect(vmix.definition.buildCommand("set_program_input", { input: "Camera 1" }, {}))
      .toBe("GET /api/?Function=ActiveInput&Input=Camera%201");
  });

  it("builds validated profile commands, including hexadecimal VISCA preset bytes", () => {
    const projector = remote("profile:epson-eb-l1755u");
    expect(projector.definition.buildCommand("set_input", { input: "hdmi2" }, {})).toBe("%1INPT 32\r");
    expect(() => projector.definition.buildCommand("set_input", { input: "serial" }, {}))
      .toThrow("valid input");

    const camera = remote("profile:ptzoptics-move-4k");
    expect(camera.definition.buildCommand("recall_preset", { preset: 10 }, {}))
      .toBe("81 01 04 3F 02 0A FF");
    expect(camera.definition.buildCommand("save_preset", { preset: 254 }, {}))
      .toBe("81 01 04 3F 01 FE FF");
  });

  it("discovers only supported Home Assistant entities and allowlists their services", () => {
    const entities = parseHomeAssistantEntities(JSON.stringify([
      { entity_id: "scene.service", state: "scening", attributes: { friendly_name: "Service" } },
      { entity_id: "light.stage", state: "on" },
      { entity_id: "lock.front_door", state: "locked" },
    ]));
    const actions = buildHomeAssistantActions(entities);
    expect(actions.map((action) => action.id)).toEqual([
      "ha:scene:turn_on:scene.service",
      "ha:light:turn_on:light.stage",
      "ha:light:turn_off:light.stage",
      "ha:light:toggle:light.stage",
    ]);
    const sceneAction = actions[0];
    if (!sceneAction) throw new Error("Home Assistant scene action was not discovered");
    expect(buildHomeAssistantCommand(sceneAction.id))
      .toBe("POST /api/services/scene/turn_on {\"entity_id\":\"scene.service\"}");
    expect(() => buildHomeAssistantCommand("ha:lock:unlock:lock.front_door"))
      .toThrow("entity is not valid");
  });
});
