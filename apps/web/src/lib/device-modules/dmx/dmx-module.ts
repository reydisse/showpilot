import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

const DMX_ACTIONS: ModuleAction[] = [
  { id: "set_channel", label: "Set Channel", category: "channels", params: [
    { id: "channel", label: "Channel (1-512)", type: "number", min: 1, max: 512, step: 1 },
    { id: "value", label: "Value (0-255)", type: "number", min: 0, max: 255, step: 1 },
  ]},
  { id: "set_intensity", label: "Set Fixture Intensity", category: "fixtures", params: [
    { id: "fixture", label: "Fixture ID", type: "string" },
    { id: "intensity", label: "Intensity (%)", type: "number", min: 0, max: 100, step: 1 },
  ]},
  { id: "recall_scene", label: "Recall Scene", category: "scenes", params: [
    { id: "scene", label: "Scene Name", type: "string" },
  ]},
  { id: "blackout", label: "Blackout", category: "master", params: [] },
  { id: "restore", label: "Restore from Blackout", category: "master", params: [] },
  { id: "set_master", label: "Set Master Dimmer", category: "master", params: [
    { id: "level", label: "Level (%)", type: "number", min: 0, max: 100, step: 1 },
  ]},
];

const DMX_FEEDBACKS: ModuleFeedback[] = [
  { id: "active_scene", label: "Active Scene", type: "string", value: "" },
  { id: "blackout_active", label: "Blackout", type: "boolean", value: false },
  { id: "master_level", label: "Master Level", type: "number", value: 100 },
];

class DMXModule extends BaseDeviceModule {
  protected async doConnect(): Promise<void> {
    throw new Error("Bridge agent required for DMX connections");
  }
  protected doDisconnect(): void {}
  getActions() { return DMX_ACTIONS; }
  async executeAction() { throw new Error("Bridge agent required"); }
  getFeedbacks() { return DMX_FEEDBACKS; }
}

export const dmxSacnDefinition: ModuleDefinition = {
  adapterType: "dmx-sacn",
  displayName: "DMX / sACN Lighting",
  category: "lighting",
  transport: "udp",
  connectivity: "bridge-required",
  configFields: [
    { key: "universe", label: "Universe", placeholder: "1", type: "number", required: true },
    { key: "host", label: "sACN Target IP (optional)", placeholder: "239.255.0.1" },
  ],
  icon: "Lightbulb",
  description: "Control DMX lighting fixtures via sACN (E1.31). Set channels, recall scenes, master dimmer. Requires ShowPilot Bridge.",
  createInstance: () => new DMXModule(),
};

export const dmxArtnetDefinition: ModuleDefinition = {
  adapterType: "dmx-artnet",
  displayName: "DMX / Art-Net Lighting",
  category: "lighting",
  transport: "udp",
  connectivity: "bridge-required",
  configFields: [
    { key: "host", label: "Art-Net Node IP", placeholder: "192.168.1.50", required: true },
    { key: "universe", label: "Universe", placeholder: "0", type: "number" },
  ],
  icon: "Lightbulb",
  description: "Control DMX lighting fixtures via Art-Net. Set channels, recall scenes, master dimmer. Requires ShowPilot Bridge.",
  createInstance: () => new DMXModule(),
};
