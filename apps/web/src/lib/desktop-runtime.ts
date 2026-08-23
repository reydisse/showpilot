import {
  isPermissionGranted as isNativeNotificationPermissionGranted,
  onAction as onNativeNotificationAction,
  requestPermission as requestNativeNotificationPermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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
  localDevicesEnabled: boolean;
  running: boolean;
  connection: "offline" | "connecting" | "connected" | "disconnected" | "unauthorized" | "error";
  pid: number | null;
  logs: string[];
  lastError: string | null;
};

export type DesktopNotificationPayload = {
  notificationId: string;
  actionUrl?: string;
  orgSlug: string;
};

export type DesktopUpdateInfo = {
  version: string;
  notes: string | null;
  date: string | null;
};

export const DESKTOP_NOTIFICATION_POLL_EVENT = "showpilot-desktop-notification-poll";

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

export function isDesktopMainWindow(): boolean {
  return isDesktopRuntime() && getCurrentWebviewWindow().label === "main";
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

function notificationNumber(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (Math.imul(31, hash) + id.charCodeAt(index)) | 0;
  }
  return (hash & 0x7fffffff) || 1;
}

export async function showDesktopNotification(
  title: string,
  body: string,
  payload?: DesktopNotificationPayload,
): Promise<boolean> {
  if (!isDesktopRuntime() || !(await isNativeNotificationPermissionGranted())) return false;
  sendNativeNotification({
    ...(payload ? { id: notificationNumber(payload.notificationId), extra: payload } : {}),
    title,
    body,
    autoCancel: true,
    group: "showpilot-operations",
  });
  return true;
}

export async function listenForDesktopNotificationActions(
  onAction: (payload: DesktopNotificationPayload) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => {};
  const listener = await onNativeNotificationAction((notification) => {
    const extra = notification.extra;
    if (
      !extra
      || typeof extra.notificationId !== "string"
      || typeof extra.orgSlug !== "string"
      || (extra.actionUrl !== undefined && typeof extra.actionUrl !== "string")
    ) {
      return;
    }
    onAction({
      notificationId: extra.notificationId,
      orgSlug: extra.orgSlug,
      ...(typeof extra.actionUrl === "string" ? { actionUrl: extra.actionUrl } : {}),
    });
  });
  return () => listener.unregister();
}

export async function focusDesktopMainWindow(): Promise<void> {
  const core = getTauriCore();
  if (!core) return;
  await core.invoke("focus_main_window");
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo | null> {
  if (!isDesktopRuntime()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30_000 });
  if (!update) return null;
  const info = {
    version: update.version,
    notes: update.body ?? null,
    date: update.date ?? null,
  };
  await update.close();
  return info;
}

export async function installDesktopUpdate(): Promise<DesktopUpdateInfo | null> {
  const core = getTauriCore();
  if (!core) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 30_000 });
  if (!update) return null;
  const info = {
    version: update.version,
    notes: update.body ?? null,
    date: update.date ?? null,
  };
  try {
    await update.downloadAndInstall();
  } finally {
    await update.close();
  }
  await core.invoke("restart_desktop");
  return info;
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
  return core.invoke<DesktopBridgeStatus>("start_bridge", {
    config,
    confirmedLocalNetwork: true,
  });
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
