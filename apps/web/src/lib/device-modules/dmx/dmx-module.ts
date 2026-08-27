import { BaseDeviceModule } from "../base-module";
import { getSharedBridgeProxy } from "../bridge-proxy";
import { findAndNormalizeAction } from "../action-params";
import type {
  BridgeDeviceProtocol,
  ModuleAction,
  ModuleDefinition,
  ModuleFeedback,
} from "../types";

export const DMX_ACTIONS: ModuleAction[] = [
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

export const DMX_FEEDBACKS: ModuleFeedback[] = [
  { id: "active_scene", label: "Active Scene", type: "string", value: "" },
  { id: "blackout_active", label: "Blackout", type: "boolean", value: false },
  { id: "master_level", label: "Master Level", type: "number", value: 100 },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dmxTarget(protocol: BridgeDeviceProtocol, settings: Record<string, unknown>): string | null {
  const universe = Number(settings.universe ?? (protocol === "dmx-sacn" ? 1 : 0));
  const minimumUniverse = protocol === "dmx-sacn" ? 1 : 0;
  const maximumUniverse = protocol === "dmx-sacn" ? 63_999 : 32_767;
  if (!Number.isInteger(universe) || universe < minimumUniverse || universe > maximumUniverse) return null;
  if (protocol === "dmx-sacn") {
    const host = typeof settings.host === "string" && settings.host.trim()
      ? settings.host.trim()
      : `239.255.${Math.floor(universe / 256)}.${universe % 256}`;
    return `${host}:5568`;
  }
  const host = typeof settings.host === "string" ? settings.host.trim() : "";
  return host ? `${host}:6454` : null;
}

export function buildDmxBridgeCommand(actionId: string, input: Record<string, unknown>): string {
  const { params } = findAndNormalizeAction(DMX_ACTIONS, actionId, input);
  return JSON.stringify({ actionId, params });
}

function parseDmxState(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return {};
    const state = parsed;
    return {
      ...(typeof state.activeScene === "string" ? { active_scene: state.activeScene } : {}),
      ...(typeof state.blackoutActive === "boolean" ? { blackout_active: state.blackoutActive } : {}),
      ...(typeof state.masterLevel === "number" ? { master_level: state.masterLevel } : {}),
    };
  } catch {
    return {};
  }
}

class DMXModule extends BaseDeviceModule {
  private proxy: ReturnType<typeof getSharedBridgeProxy> | null = null;
  private target = "";
  private unsubscribeEvent: (() => void) | null = null;
  private feedbacks = DMX_FEEDBACKS.map((feedback) => ({ ...feedback }));

  constructor(
    private readonly settings: Record<string, unknown>,
    private readonly protocol: "dmx-sacn" | "dmx-artnet",
  ) {
    super();
  }

  protected async doConnect(): Promise<void> {
    const orgId = typeof this.settings.orgId === "string" ? this.settings.orgId : "";
    const target = dmxTarget(this.protocol, this.settings);
    if (!orgId || !target) throw new Error("Bridge, DMX target, and universe are required");
    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) throw new Error("Bridge is offline");
    this.target = target;
    this.unsubscribeEvent = this.proxy.onDeviceEvent((eventTarget, eventName, data) => {
      if (eventTarget !== target || eventName !== "dmx-state") return;
      const values = parseDmxState(data);
      for (const feedback of this.feedbacks) {
        if (!(feedback.id in values)) continue;
        feedback.value = values[feedback.id];
        this.emitFeedback(feedback.id, feedback.value);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error("DMX connection timed out"));
      }, 5_000);
      const unsubscribe = this.proxy!.onDeviceStatus((eventTarget, connected) => {
        if (eventTarget !== target) return;
        window.clearTimeout(timeout);
        unsubscribe();
        if (connected) resolve();
        else reject(new Error("Bridge could not prepare the DMX output"));
      });
      this.proxy!.connectDevice(this.protocol, target, this.settings);
    });
  }

  protected doDisconnect(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
    if (this.proxy && this.target) this.proxy.disconnectDevice(this.target);
    this.target = "";
  }

  getActions() { return DMX_ACTIONS; }
  getFeedbacks() { return this.feedbacks; }

  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    if (!this.proxy || !this.target || this.connectionStatus() !== "connected") throw new Error("DMX output is not connected");
    await this.proxy.sendCommand(this.protocol, this.target, buildDmxBridgeCommand(actionId, params));
  }
}

function remoteControl(protocol: "dmx-sacn" | "dmx-artnet") {
  return {
    protocol,
    target: (settings: Record<string, unknown>) => dmxTarget(protocol, settings),
    connectionSettings: (settings: Record<string, unknown>) => settings,
    actions: () => DMX_ACTIONS,
    feedbacks: () => DMX_FEEDBACKS,
    buildCommand: (actionId: string, params: Record<string, unknown>) => buildDmxBridgeCommand(actionId, params),
    parseEvent: (eventName: string, data: string) => eventName === "dmx-state" ? parseDmxState(data) : {},
  } satisfies NonNullable<ModuleDefinition["remoteControl"]>;
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
    { key: "fixtures", label: "Fixture intensity channels (JSON)", placeholder: "{\"front\":1,\"stage\":24}" },
    { key: "scenes", label: "Scenes (JSON)", placeholder: "{\"service\":{\"1\":255,\"24\":180}}" },
  ],
  icon: "Lightbulb",
  description: "Control DMX lighting through sACN with channels, fixture intensity, scenes, blackout, and master dimmer. Requires ShowPilot Bridge.",
  remoteControl: remoteControl("dmx-sacn"),
  createInstance: (settings) => new DMXModule(settings, "dmx-sacn"),
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
    { key: "fixtures", label: "Fixture intensity channels (JSON)", placeholder: "{\"front\":1,\"stage\":24}" },
    { key: "scenes", label: "Scenes (JSON)", placeholder: "{\"service\":{\"1\":255,\"24\":180}}" },
  ],
  icon: "Lightbulb",
  description: "Control DMX lighting through Art-Net with channels, fixture intensity, scenes, blackout, and master dimmer. Requires ShowPilot Bridge.",
  remoteControl: remoteControl("dmx-artnet"),
  createInstance: (settings) => new DMXModule(settings, "dmx-artnet"),
};
