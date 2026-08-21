export type DesktopEngineInfo = {
  native: boolean;
  platform: string;
  version: string;
  cachePath: string | null;
};

export type DesktopWindowKind = "timer" | "show-board" | "check-in";

export type DesktopBridgeConfig = {
  site: string;
  org: string;
  key: string;
  propresenterHost?: string;
  propresenterPort?: number;
  propresenterApiPort?: number;
  propresenterPassword?: string;
};

export type DesktopBridgeStatus = {
  configured: boolean;
  running: boolean;
  pid: number | null;
  logs: string[];
};

type TauriCore = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCore };
  }
}

function getTauriCore(): TauriCore | null {
  if (typeof window === "undefined") return null;
  return window.__TAURI__?.core ?? null;
}

export function isDesktopRuntime(): boolean {
  return getTauriCore() !== null;
}

export function isDesktopNotificationSupported(): boolean {
  return isDesktopRuntime();
}

export async function getDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (!isDesktopRuntime()) return "denied";
  return (await isNativeNotificationPermissionGranted()) ? "granted" : "default";
}

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (!isDesktopRuntime()) return "denied";
  if (await isNativeNotificationPermissionGranted()) return "granted";
  return requestNativeNotificationPermission();
}

export async function showDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!isDesktopRuntime() || !(await isNativeNotificationPermissionGranted())) return false;
  sendNativeNotification({ title, body });
  return true;
}

export async function getDesktopEngineInfo(): Promise<DesktopEngineInfo | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<DesktopEngineInfo>("engine_info");
}

export async function openDesktopWindow(
  kind: DesktopWindowKind,
  orgSlug: string,
): Promise<void> {
  const core = getTauriCore();
  if (!core) throw new Error("ShowPilot Desktop is not available");
  await core.invoke("open_companion_window", { kind, orgSlug });
}

export async function cacheDesktopService(payload: unknown): Promise<string | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<string>("cache_service", {
    payload: JSON.stringify(payload),
  });
}

export async function getDesktopBridgeStatus(): Promise<DesktopBridgeStatus | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<DesktopBridgeStatus>("bridge_status");
}

export async function startDesktopBridge(
  config: DesktopBridgeConfig,
): Promise<DesktopBridgeStatus> {
  const core = getTauriCore();
  if (!core) throw new Error("ShowPilot Desktop is not available");
  return core.invoke<DesktopBridgeStatus>("start_bridge", { config });
}

export async function stopDesktopBridge(): Promise<void> {
  const core = getTauriCore();
  if (!core) return;
  await core.invoke("stop_bridge");
}

export async function getDesktopFullscreenState(): Promise<boolean | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<boolean>("display_fullscreen_state");
}

export async function toggleDesktopFullscreen(): Promise<boolean | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<boolean>("toggle_display_fullscreen");
}
import {
  isPermissionGranted as isNativeNotificationPermissionGranted,
  requestPermission as requestNativeNotificationPermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
