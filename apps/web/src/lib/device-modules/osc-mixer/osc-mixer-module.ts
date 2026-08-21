import { BaseDeviceModule } from "../base-module";
import { getSharedBridgeProxy } from "../bridge-proxy";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

const MIXER_ACTIONS: ModuleAction[] = [
  { id: "set_channel_fader", label: "Set Channel Fader", category: "channels", params: [
    { id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1 },
    { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01 },
  ]},
  { id: "mute_channel", label: "Mute Channel", category: "channels", params: [
    { id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1 },
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
    { id: "channel", label: "Channel", type: "number", min: 1, max: 40, step: 1 },
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

type ConsoleType = "x32" | "wing";

function integerParam(params: Record<string, unknown>, name: string, min: number, max: number) {
  const value = Number(params[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function levelParam(params: Record<string, unknown>) {
  const value = Number(params.level);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Level must be between 0 and 1");
  return value;
}

export function buildMixerOscCommand(
  consoleType: ConsoleType,
  actionId: string,
  params: Record<string, unknown>,
): string {
  const channel = () => integerParam(params, "channel", 1, consoleType === "wing" ? 40 : 32);
  const dca = () => integerParam(params, "dca", 1, 8);
  const muted = () => Boolean(params.muted);

  if (consoleType === "wing") {
    switch (actionId) {
      case "set_channel_fader": return `/ch/${channel()}/fdr f:${levelParam(params)}`;
      case "mute_channel": return `/ch/${channel()}/mute i:${muted() ? 1 : 0}`;
      case "set_dca_fader": return `/dca/${dca()}/fdr f:${levelParam(params)}`;
      case "mute_dca": return `/dca/${dca()}/mute i:${muted() ? 1 : 0}`;
      default:
        throw new Error(`${actionId} is not available through the WING OSC fallback`);
    }
  }

  const twoDigits = (value: number) => String(value).padStart(2, "0");
  switch (actionId) {
    case "set_channel_fader": return `/ch/${twoDigits(channel())}/mix/fader f:${levelParam(params)}`;
    case "mute_channel": return `/ch/${twoDigits(channel())}/mix/on i:${muted() ? 0 : 1}`;
    case "set_dca_fader": return `/dca/${dca()}/fader f:${levelParam(params)}`;
    case "mute_dca": return `/dca/${dca()}/on i:${muted() ? 0 : 1}`;
    case "recall_scene": return `/-action/goscene i:${integerParam(params, "scene", 1, 100) - 1}`;
    case "recall_snippet": return `/-action/gosnippet i:${integerParam(params, "snippet", 1, 100) - 1}`;
    case "set_bus_send": {
      const bus = integerParam(params, "bus", 1, 16);
      return `/ch/${twoDigits(channel())}/mix/${twoDigits(bus)}/level f:${levelParam(params)}`;
    }
    default: throw new Error(`Unknown mixer action: ${actionId}`);
  }
}

class OSCMixerModule extends BaseDeviceModule {
  private proxy: ReturnType<typeof getSharedBridgeProxy> | null = null;
  private target = "";
  private settings: Record<string, unknown>;
  private consoleType: ConsoleType;

  constructor(settings: Record<string, unknown>) {
    super();
    this.settings = settings;
    this.consoleType = String(settings.consoleName || "x32").toLowerCase() === "wing" ? "wing" : "x32";
  }

  protected async doConnect(): Promise<void> {
    const orgId = String(this.settings.orgId || "");
    const host = String(this.settings.host || "").trim();
    const port = Number(this.settings.port || (this.consoleType === "wing" ? 2223 : 10023));
    if (!orgId || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("Local device engine, mixer host, and port are required");
    }
    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) throw new Error("Local device engine is offline");
    this.target = `${host}:${port}`;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error("Mixer connection timed out"));
      }, 5_000);
      const unsubscribe = this.proxy!.onDeviceStatus((target, connected) => {
        if (target !== this.target) return;
        window.clearTimeout(timeout);
        unsubscribe();
        if (connected) resolve();
        else reject(new Error("Local device engine could not prepare the mixer connection"));
      });
      this.proxy!.connectDevice("osc", this.target, this.settings);
    });
  }

  protected doDisconnect(): void {
    if (this.proxy && this.target) this.proxy.disconnectDevice(this.target);
    this.target = "";
  }

  getActions() { return MIXER_ACTIONS; }

  async executeAction(actionId: string, params: Record<string, unknown>) {
    if (!this.proxy || !this.target || this.connectionStatus() !== "connected") {
      throw new Error("Mixer is not connected");
    }
    await this.proxy.sendCommand("osc", this.target, buildMixerOscCommand(this.consoleType, actionId, params));
  }

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
    { key: "port", label: "Port (optional)", placeholder: "X32: 10023 · WING: 2223", type: "number" },
    { key: "consoleName", label: "Console Type", type: "select", required: true, options: [
      { value: "x32", label: "Behringer X32 / M32" },
      { value: "wing", label: "Behringer WING (OSC fallback)" },
    ] },
  ],
  icon: "Activity",
  description: "Control X32/M32 and core WING fader/mute functions through the desktop local device engine or a venue Bridge.",
  createInstance: (settings) => new OSCMixerModule(settings),
};
