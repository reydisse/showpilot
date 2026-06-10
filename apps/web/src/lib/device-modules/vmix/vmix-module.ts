import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";

interface VMixSettings {
  host: string;
  port?: number;
}

const VMIX_ACTIONS: ModuleAction[] = [
  { id: "cut", label: "Cut", category: "transitions", params: [] },
  { id: "fade", label: "Fade", category: "transitions", params: [
    { id: "duration", label: "Duration (ms)", type: "number", min: 0, max: 5000, step: 100, default: 1000 },
  ]},
  { id: "set_program_input", label: "Set Program Input", category: "inputs", params: [
    { id: "input", label: "Input Number", type: "string" },
  ]},
  { id: "set_preview_input", label: "Set Preview Input", category: "inputs", params: [
    { id: "input", label: "Input Number", type: "string" },
  ]},
  { id: "start_streaming", label: "Start Streaming", category: "streaming", params: [] },
  { id: "stop_streaming", label: "Stop Streaming", category: "streaming", params: [] },
  { id: "start_recording", label: "Start Recording", category: "recording", params: [] },
  { id: "stop_recording", label: "Stop Recording", category: "recording", params: [] },
  { id: "start_external", label: "Start External", category: "output", params: [] },
  { id: "stop_external", label: "Stop External", category: "output", params: [] },
];

const VMIX_FEEDBACKS: ModuleFeedback[] = [
  { id: "active_input", label: "Active Input", type: "string", value: "" },
  { id: "preview_input", label: "Preview Input", type: "string", value: "" },
  { id: "streaming_active", label: "Streaming", type: "boolean", value: false },
  { id: "recording_active", label: "Recording", type: "boolean", value: false },
];

const ACTION_MAP: Record<string, (p: Record<string, unknown>) => string> = {
  cut: () => "Function=Cut",
  fade: (p) => `Function=Fade&Duration=${p.duration ?? 1000}`,
  set_program_input: (p) => `Function=ActiveInput&Input=${p.input}`,
  set_preview_input: (p) => `Function=PreviewInput&Input=${p.input}`,
  start_streaming: () => "Function=StartStreaming",
  stop_streaming: () => "Function=StopStreaming",
  start_recording: () => "Function=StartRecording",
  stop_recording: () => "Function=StopRecording",
  start_external: () => "Function=StartExternal",
  stop_external: () => "Function=StopExternal",
};

/**
 * vMix module — connects via HTTP API.
 * Browser-direct HTTP requests to vMix on the local network.
 */
export class VMixModule extends BaseDeviceModule {
  private host: string;
  private port: number;
  private baseUrl: string;

  constructor(settings: VMixSettings) {
    super();
    this.host = settings.host;
    this.port = settings.port ?? 8088;
    this.baseUrl = `http://${this.host}:${this.port}/api/`;
  }

  protected async doConnect(): Promise<void> {
    // Test connection by fetching API root
    const res = await fetch(this.baseUrl);
    if (!res.ok) throw new Error(`vMix API returned ${res.status}`);
  }

  protected doDisconnect(): void {
    // HTTP is stateless — nothing to disconnect
  }

  getActions(): ModuleAction[] {
    return VMIX_ACTIONS;
  }

  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    if (this.connectionStatus() !== "connected") throw new Error("Not connected");

    const mapper = ACTION_MAP[actionId];
    if (!mapper) throw new Error(`Unknown action: ${actionId}`);

    const query = mapper(params);
    const res = await fetch(`${this.baseUrl}?${query}`);
    if (!res.ok) throw new Error(`vMix command failed: ${res.status}`);
  }

  getFeedbacks(): ModuleFeedback[] {
    return VMIX_FEEDBACKS;
  }
}

export const vmixModuleDefinition: ModuleDefinition = {
  adapterType: "vmix",
  displayName: "vMix",
  category: "video",
  transport: "http",
  connectivity: "browser-direct",
  configFields: [
    { key: "host", label: "Host / IP", placeholder: "192.168.1.200", required: true },
    { key: "port", label: "Port", placeholder: "8088", type: "number" },
  ],
  icon: "Monitor",
  description: "Control vMix via HTTP API. Switch inputs, trigger transitions, manage streaming and recording.",
  createInstance: (settings) => new VMixModule(settings as unknown as VMixSettings),
};
