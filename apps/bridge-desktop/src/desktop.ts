import { invoke } from "@tauri-apps/api/core";

export type BridgeConfig = {
  site: string;
  org: string;
  key: string;
  propresenterHost?: string;
  propresenterPort?: number;
  propresenterApiPort?: number;
  propresenterPassword?: string;
  midiInputName?: string;
};

export type MidiInputInfo = { id: string; name: string };
export type MtcStatus = { connected: boolean; inputName: string | null; timecode: string | null };

export type BridgeStatus = {
  configured: boolean;
  running: boolean;
  connection: "offline" | "connecting" | "connected" | "disconnected" | "unauthorized" | "error";
  pid: number | null;
  logs: string[];
};

export async function getBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    return await invoke<BridgeConfig | null>("get_bridge_config");
  } catch {
    return null;
  }
}

export async function getBridgeStatus(): Promise<BridgeStatus> {
  try {
    return await invoke<BridgeStatus>("bridge_status");
  } catch {
    return { configured: false, running: false, connection: "offline", pid: null, logs: [] };
  }
}

export function startBridge(config: BridgeConfig): Promise<BridgeStatus> {
  return invoke<BridgeStatus>("start_bridge", { config });
}

export async function stopBridge(): Promise<void> {
  await invoke("stop_bridge");
}

export function listMidiInputs(): Promise<MidiInputInfo[]> { return invoke("list_midi_inputs"); }
export function startMtcInput(inputId: string): Promise<MtcStatus> { return invoke("start_mtc_input", { inputId }); }
export function stopMtcInput(): Promise<void> { return invoke("stop_mtc_input"); }
export function getMtcStatus(): Promise<MtcStatus> { return invoke("mtc_status"); }
