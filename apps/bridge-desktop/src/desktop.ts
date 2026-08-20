import { invoke } from "@tauri-apps/api/core";

export type BridgeConfig = {
  site: string;
  org: string;
  key: string;
  propresenterHost?: string;
  propresenterPort?: number;
  propresenterApiPort?: number;
  propresenterPassword?: string;
};

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
