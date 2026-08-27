import { BaseDeviceModule } from "../base-module";
import { getSharedBridgeProxy } from "../bridge-proxy";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";
import { findAndNormalizeAction } from "../action-params";

export const ATEM_ACTIONS: ModuleAction[] = [
  { id: "set_program_input", label: "Set Program Input", category: "switching", params: [
    { id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "set_preview_input", label: "Set Preview Input", category: "switching", params: [
    { id: "input", label: "Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "cut", label: "Cut", category: "transitions", params: [] },
  { id: "auto_transition", label: "Auto Transition", category: "transitions", params: [] },
  { id: "fade_to_black", label: "Fade to Black", category: "transitions", params: [] },
  { id: "run_macro", label: "Run Macro", category: "macros", params: [
    { id: "macro", label: "Macro Index", type: "number", min: 0, max: 99, step: 1 },
  ]},
  { id: "set_aux_source", label: "Set Aux Source", category: "aux", params: [
    { id: "aux", label: "Aux Output", type: "number", min: 1, max: 6, step: 1 },
    { id: "source", label: "Source Input", type: "number", min: 1, max: 20, step: 1 },
  ]},
  { id: "toggle_downstream_key", label: "Toggle DSK", category: "keying", params: [
    { id: "key", label: "DSK", type: "number", min: 1, max: 4, step: 1 },
  ]},
];

export const ATEM_FEEDBACKS: ModuleFeedback[] = [
  { id: "program_input", label: "Program Input", type: "number", value: 0 },
  { id: "preview_input", label: "Preview Input", type: "number", value: 0 },
  { id: "transition_position", label: "Transition Position", type: "number", value: 0 },
  { id: "ftb_active", label: "Fade to Black", type: "boolean", value: false },
  { id: "tally_program", label: "Tally Program", type: "string", value: "[]" },
  { id: "tally_preview", label: "Tally Preview", type: "string", value: "[]" },
];

interface AtemStateEvent {
  programInput?: number;
  previewInput?: number;
  transitionPosition?: number;
  ftbActive?: boolean;
  tallyProgram?: number[];
  tallyPreview?: number[];
}

export function buildAtemBridgeCommand(actionId: string, input: Record<string, unknown>): string {
  const { params } = findAndNormalizeAction(ATEM_ACTIONS, actionId, input);
  return JSON.stringify({ actionId, params });
}

export function parseAtemState(data: string): Record<string, unknown> {
  let state: AtemStateEvent;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    state = parsed;
  } catch {
    return {};
  }
  return {
    ...(typeof state.programInput === "number" ? { program_input: state.programInput } : {}),
    ...(typeof state.previewInput === "number" ? { preview_input: state.previewInput } : {}),
    ...(typeof state.transitionPosition === "number" ? { transition_position: state.transitionPosition } : {}),
    ...(typeof state.ftbActive === "boolean" ? { ftb_active: state.ftbActive } : {}),
    ...(Array.isArray(state.tallyProgram) ? { tally_program: JSON.stringify(state.tallyProgram) } : {}),
    ...(Array.isArray(state.tallyPreview) ? { tally_preview: JSON.stringify(state.tallyPreview) } : {}),
  };
}

class ATEMModule extends BaseDeviceModule {
  private proxy: ReturnType<typeof getSharedBridgeProxy> | null = null;
  private target = "";
  private settings: Record<string, unknown>;
  private unsubscribeEvent: (() => void) | null = null;
  private feedbacks: ModuleFeedback[] = ATEM_FEEDBACKS.map((feedback) => ({ ...feedback }));

  constructor(settings: Record<string, unknown>) {
    super();
    this.settings = settings;
  }

  protected async doConnect(): Promise<void> {
    const orgId = String(this.settings.orgId || "");
    const host = String(this.settings.host || "").trim();
    const port = Number(this.settings.port || 9910);
    if (!orgId || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("Local device engine, ATEM host, and port are required");
    }

    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) throw new Error("Local device engine is offline");
    this.target = `${host}:${port}`;
    this.unsubscribeEvent = this.proxy.onDeviceEvent((target, eventName, data) => {
      if (target !== this.target || eventName !== "atem-state") return;
      this.applyState(data);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          unsubscribe();
          reject(new Error("ATEM connection timed out"));
        }, 8_000);
        const unsubscribe = this.proxy!.onDeviceStatus((target, connected) => {
          if (target !== this.target) return;
          window.clearTimeout(timeout);
          unsubscribe();
          if (connected) resolve();
          else reject(new Error("Local device engine could not connect to the ATEM"));
        });
        this.proxy!.connectDevice("atem", this.target, this.settings);
      });
    } catch (error) {
      this.unsubscribeEvent?.();
      this.unsubscribeEvent = null;
      throw error;
    }
  }

  protected doDisconnect(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeEvent = null;
    if (this.proxy && this.target) this.proxy.disconnectDevice(this.target);
    this.target = "";
  }

  getActions() { return ATEM_ACTIONS; }

  async executeAction(actionId: string, params: Record<string, unknown>) {
    if (!this.proxy || !this.target || this.connectionStatus() !== "connected") {
      throw new Error("ATEM is not connected");
    }
    await this.proxy.sendCommand("atem", this.target, JSON.stringify({ actionId, params }));
  }

  getFeedbacks() { return this.feedbacks; }

  private applyState(raw: string) {
    const values = parseAtemState(raw);
    for (const feedback of this.feedbacks) {
      const value = values[feedback.id];
      if (value === undefined) continue;
      feedback.value = value;
      this.emitFeedback(feedback.id, value);
    }
  }
}

export const atemModuleDefinition: ModuleDefinition = {
  adapterType: "atem",
  displayName: "Blackmagic ATEM",
  category: "video",
  transport: "tcp",
  connectivity: "bridge-required",
  configFields: [
    { key: "host", label: "Switcher IP", placeholder: "192.168.1.240", required: true },
    { key: "port", label: "Port", placeholder: "9910", type: "number" },
  ],
  icon: "Monitor",
  description: "Control Blackmagic ATEM switchers through the desktop local device engine or a venue Bridge.",
  remoteControl: {
    protocol: "atem",
    target(settings) {
      const host = typeof settings.host === "string" ? settings.host.trim() : "";
      const port = Number(settings.port || 9910);
      return host && Number.isInteger(port) && port >= 1 && port <= 65_535 ? `${host}:${port}` : null;
    },
    actions: () => ATEM_ACTIONS,
    feedbacks: () => ATEM_FEEDBACKS,
    buildCommand: (actionId, params) => buildAtemBridgeCommand(actionId, params),
    parseEvent: (eventName, data) => eventName === "atem-state" ? parseAtemState(data) : {},
  },
  createInstance: (settings) => new ATEMModule(settings),
};
