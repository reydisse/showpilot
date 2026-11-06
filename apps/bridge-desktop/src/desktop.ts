import { invoke } from "@tauri-apps/api/core";

export type BridgeConfig = {
  site: string;
  org: string;
  key: string;
  propresenterHost?: string;
  propresenterPort?: number;
  propresenterApiPort?: number;
  propresenterPassword?: string;
  propresenterPasswordConfigured?: boolean;
  clearPropresenterPassword?: boolean;
  midiInputName?: string;
  ltcInput?: LtcInputConfig;
};

export const LTC_RATES = [
  { value: "24-ndf", label: "24 fps" },
  { value: "25-ndf", label: "25 fps" },
  { value: "29.97-ndf", label: "29.97 fps, non-drop" },
  { value: "29.97-df", label: "29.97 fps, drop-frame" },
  { value: "30-ndf", label: "30 fps" },
] as const;
export type LtcRate = typeof LTC_RATES[number]["value"];
export type LtcInputConfig = { deviceId: string; deviceName: string; channel: number; rate: LtcRate };
export type AudioInputInfo = { id: string; name: string; channels: number };
export type LtcStatus = {
  selected: LtcInputConfig | null;
  connected: boolean;
  locked: boolean;
  timecode: string | null;
  lastFrameAgeMs: number | null;
  level: number;
  sampleRate: number | null;
  error: string | null;
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
  return invoke<BridgeConfig | null>("get_bridge_config");
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

async function inputCommand<T>(command: string, label: string, args?: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<T>(command, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not respond. Check device access and retry.`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function listMidiInputs(): Promise<MidiInputInfo[]> { return inputCommand("list_midi_inputs", "MIDI input scan", undefined, 8000); }
export function startMtcInput(inputId: string): Promise<MtcStatus> { return inputCommand("start_mtc_input", "MTC connection", { inputId }); }
export function stopMtcInput(): Promise<void> { return inputCommand("stop_mtc_input", "MTC stop"); }
export function getMtcStatus(): Promise<MtcStatus> { return inputCommand("mtc_status", "MTC status", undefined, 3000); }
export function listAudioInputs(): Promise<AudioInputInfo[]> { return inputCommand("list_audio_inputs", "Audio input scan", undefined, 8000); }
export function startLtcInput(config: LtcInputConfig): Promise<LtcStatus> { return inputCommand("start_ltc_input", "LTC connection", { config }); }
export function stopLtcInput(): Promise<void> { return inputCommand("stop_ltc_input", "LTC stop"); }
export function getLtcStatus(): Promise<LtcStatus> { return inputCommand("ltc_status", "LTC status", undefined, 3000); }
