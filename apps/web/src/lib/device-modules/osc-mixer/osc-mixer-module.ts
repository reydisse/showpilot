import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

const MIXER_ACTIONS: ModuleAction[] = [
  { id: "set_channel_fader", label: "Set Channel Fader", category: "channels", params: [
    { id: "channel", label: "Channel", type: "number", min: 1, max: 32, step: 1 },
    { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01 },
  ]},
  { id: "mute_channel", label: "Mute Channel", category: "channels", params: [
    { id: "channel", label: "Channel", type: "number", min: 1, max: 32, step: 1 },
    { id: "muted", label: "Muted", type: "boolean" },
  ]},
  { id: "set_dca_fader", label: "Set DCA Fader", category: "dca", params: [
    { id: "dca", label: "DCA Group", type: "number", min: 1, max: 8, step: 1 },
    { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01 },
  ]},
  { id: "mute_dca", label: "Mute DCA", category: "dca", params: [
    { id: "dca", label: "DCA Group", type: "number", min: 1, max: 8, step: 1 },
    { id: "muted", label: "Muted", type: "boolean" },
  ]},
  { id: "recall_scene", label: "Recall Scene", category: "scenes", params: [
    { id: "scene", label: "Scene Number", type: "number", min: 1, max: 100, step: 1 },
  ]},
  { id: "recall_snippet", label: "Recall Snippet", category: "scenes", params: [
    { id: "snippet", label: "Snippet Number", type: "number", min: 1, max: 100, step: 1 },
  ]},
  { id: "set_bus_send", label: "Set Bus Send", category: "routing", params: [
    { id: "channel", label: "Channel", type: "number", min: 1, max: 32, step: 1 },
    { id: "bus", label: "Bus", type: "number", min: 1, max: 16, step: 1 },
    { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01 },
  ]},
];

const MIXER_FEEDBACKS: ModuleFeedback[] = [
  { id: "channel_fader", label: "Channel Fader Levels", type: "string", value: "[]" },
  { id: "channel_mute", label: "Channel Mute States", type: "string", value: "[]" },
  { id: "dca_fader", label: "DCA Fader Levels", type: "string", value: "[]" },
  { id: "current_scene", label: "Current Scene", type: "number", value: 0 },
];

/** Bridge-required stub — cannot connect from browser (OSC/UDP) */
class OSCMixerModule extends BaseDeviceModule {
  protected async doConnect(): Promise<void> {
    throw new Error("Bridge agent required for OSC connections");
  }
  protected doDisconnect(): void {}
  getActions() { return MIXER_ACTIONS; }
  async executeAction() { throw new Error("Bridge agent required"); }
  getFeedbacks() { return MIXER_FEEDBACKS; }
}

export const oscMixerDefinition: ModuleDefinition = {
  adapterType: "osc-mixer",
  displayName: "Behringer X32 / Wing",
  category: "mixer",
  transport: "osc",
  connectivity: "bridge-required",
  configFields: [
    { key: "host", label: "Host / IP", placeholder: "192.168.1.100", required: true },
    { key: "port", label: "Port", placeholder: "10023", type: "number" },
    { key: "consoleName", label: "Console Type", placeholder: "x32" },
  ],
  icon: "Activity",
  description: "Control Behringer X32, X32 Compact, Wing, and compatible consoles via OSC. Requires ShowPilot Bridge.",
  createInstance: () => new OSCMixerModule(),
};
