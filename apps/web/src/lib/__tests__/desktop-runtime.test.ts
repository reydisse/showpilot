import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const nativeNotifications = vi.hoisted(() => ({
  granted: false,
  sent: [] as Array<Record<string, unknown>>,
  action: null as ((notification: { extra?: Record<string, unknown> }) => void) | null,
  unregister: vi.fn(),
  permission: vi.fn(),
}));
const nativeUpdater = vi.hoisted(() => ({
  available: null as null | { version: string; body?: string; date?: string },
  close: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
}));
const currentDesktopWindow = vi.hoisted(() => ({ label: "main" }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: currentDesktopWindow.label }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => nativeNotifications.permission(),
  requestPermission: async () => {
    nativeNotifications.granted = true;
    return "granted" as const;
  },
  sendNotification: (options: { title: string; body?: string }) => {
    nativeNotifications.sent.push(options);
  },
  onAction: async (handler: (notification: { extra?: Record<string, unknown> }) => void) => {
    nativeNotifications.action = handler;
    return { unregister: nativeNotifications.unregister };
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => nativeUpdater.available
    ? {
        ...nativeUpdater.available,
        close: nativeUpdater.close,
        downloadAndInstall: nativeUpdater.install,
      }
    : null,
}));
import {
  cacheDesktopService,
  invokeDesktopLocalShow,
  checkDesktopUpdate,
  focusDesktopMainWindow,
  getDesktopBridgeStatus,
  getDesktopFullscreenState,
  getDesktopEngineInfo,
  getDesktopNotificationPermission,
  isDesktopMainWindow,
  isDesktopRuntime,
  isDesktopNotificationSupported,
  installDesktopUpdate,
  isDesktopLocalDeviceMode,
  listenForDesktopNotificationActions,
  openDesktopWindow,
  requestDesktopNotificationPermission,
  showDesktopNotification,
  startDesktopBridge,
  stopDesktopBridge,
  toggleDesktopFullscreen,
} from "@/lib/desktop-runtime";

const originalTauri = window.__TAURI__;

beforeEach(() => {
  nativeNotifications.granted = false;
  nativeNotifications.permission.mockReset().mockImplementation(async () => nativeNotifications.granted);
  nativeNotifications.sent.length = 0;
  nativeNotifications.action = null;
  nativeNotifications.unregister.mockClear();
  nativeUpdater.available = null;
  nativeUpdater.close.mockClear();
  nativeUpdater.install.mockClear();
  currentDesktopWindow.label = "main";
});

afterEach(() => {
  window.__TAURI__ = originalTauri;
  vi.useRealTimers();
});

describe("desktop runtime boundary", () => {
  it("bounds local-show IPC without retrying the native command", async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(() => new Promise<never>(() => {}));
      window.__TAURI__ = { core: { invoke } };
      const result = expect(invokeDesktopLocalShow({ operation: "status" })).rejects.toThrow("did not reply");
      await vi.advanceTimersByTimeAsync(18000);
      await result;
      expect(invoke).toHaveBeenCalledExactlyOnceWith("local_show_command", { request: { operation: "status" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("recognizes local-device mode reported by current and legacy Desktop engines", () => {
    const base = {
      configured: true,
      running: false,
      connection: "offline" as const,
      pid: null,
      logs: [],
      lastError: null,
    };

    expect(isDesktopLocalDeviceMode(null)).toBe(false);
    expect(isDesktopLocalDeviceMode({ ...base, localDevicesEnabled: false })).toBe(false);
    expect(isDesktopLocalDeviceMode({ ...base, localDevicesEnabled: true })).toBe(true);
    expect(isDesktopLocalDeviceMode({ ...base, running: true })).toBe(true);
  });

  it("stays inert in a normal browser", async () => {
    window.__TAURI__ = undefined;
    expect(isDesktopRuntime()).toBe(false);
    expect(isDesktopMainWindow()).toBe(false);
    expect(isDesktopNotificationSupported()).toBe(false);
    await expect(getDesktopEngineInfo()).resolves.toBeNull();
    await expect(cacheDesktopService({ id: "show-1" })).resolves.toBeNull();
    await expect(getDesktopBridgeStatus()).resolves.toBeNull();
    await expect(requestDesktopNotificationPermission()).resolves.toBe("denied");
    await expect(getDesktopNotificationPermission()).resolves.toBe("denied");
    await expect(showDesktopNotification("Test", "Body")).resolves.toBe(false);
    await expect(focusDesktopMainWindow()).resolves.toBeUndefined();
    await expect(checkDesktopUpdate()).resolves.toBeNull();
    await expect(installDesktopUpdate()).resolves.toBeNull();
  });

  it("uses only the validated native commands", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push([command, args]);
      if (command === "engine_info") {
        return {
          native: true,
          platform: "macos",
          version: "0.1.0",
          cachePath: "/tmp/showpilot",
        } as T;
      }
      if (command === "display_fullscreen_state") return false as T;
      if (command === "toggle_display_fullscreen") return true as T;
      return "ok" as T;
    };
    window.__TAURI__ = { core: { invoke } };

    expect(isDesktopRuntime()).toBe(true);
    expect(isDesktopMainWindow()).toBe(true);
    currentDesktopWindow.label = "show-board-faithfire-production";
    expect(isDesktopMainWindow()).toBe(false);
    currentDesktopWindow.label = "main";
    await expect(getDesktopEngineInfo()).resolves.toMatchObject({ native: true });
    await openDesktopWindow("timer", "faithfire-production");
    await cacheDesktopService({ id: "show-1" });
    await startDesktopBridge({
      site: "https://showpilot.tech",
      org: "faithfire-production",
      key: "sp_test",
    });
    await stopDesktopBridge();
    await expect(getDesktopFullscreenState()).resolves.toBe(false);
    await expect(toggleDesktopFullscreen()).resolves.toBe(true);

    expect(calls[1]).toEqual([
      "open_companion_window",
      { kind: "timer", orgSlug: "faithfire-production" },
    ]);
    expect(calls[2]).toEqual([
      "cache_service",
      { payload: JSON.stringify({ id: "show-1" }) },
    ]);
    expect(calls[3]).toEqual([
      "start_bridge",
      {
        config: { site: "https://showpilot.tech", org: "faithfire-production", key: "sp_test" },
        confirmedLocalNetwork: true,
      },
    ]);
    expect(calls[4]).toEqual(["stop_bridge", undefined]);
    expect(calls[5]).toEqual(["display_fullscreen_state", undefined]);
    expect(calls[6]).toEqual(["toggle_display_fullscreen", undefined]);
  });

  it("uses the native notification plugin only after permission is granted", async () => {
    window.__TAURI__ = {
      core: { invoke: async <T,>() => null as T },
    };

    expect(isDesktopNotificationSupported()).toBe(true);
    await expect(getDesktopNotificationPermission()).resolves.toBe("default");
    await expect(showDesktopNotification("Before", "Permission")).resolves.toBe(false);
    await expect(requestDesktopNotificationPermission()).resolves.toBe("granted");
    await expect(getDesktopNotificationPermission()).resolves.toBe("granted");
    await expect(showDesktopNotification("ShowPilot", "Cue ready", {
      notificationId: "notice-1",
      actionUrl: "/chat?room=ops",
      orgSlug: "faithfire-production",
    })).resolves.toBe(true);
    expect(nativeNotifications.sent).toEqual([expect.objectContaining({
      title: "ShowPilot",
      body: "Cue ready",
      autoCancel: true,
      group: "showpilot-operations",
      extra: {
        notificationId: "notice-1",
        actionUrl: "/chat?room=ops",
        orgSlug: "faithfire-production",
      },
    })]);
  });

  it("does not send a stale alert when permission arrives after the deadline", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    const permission = deferred<boolean>();
    nativeNotifications.permission.mockReturnValueOnce(permission.promise);
    const controller = new AbortController();
    const pending = showDesktopNotification("Expired", "Alert", undefined, controller.signal);
    controller.abort();
    permission.resolve(true);
    await expect(pending).rejects.toThrow();
    expect(nativeNotifications.sent).toEqual([]);
  });

  it("deactivates native action callbacks before awaiting listener removal", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn() } };
    nativeNotifications.unregister.mockRejectedValueOnce(new Error("Native cleanup failed"));
    const action = vi.fn();
    const remove = await listenForDesktopNotificationActions(action);
    await expect(remove()).rejects.toThrow("Native cleanup failed");
    nativeNotifications.action?.({ extra: { notificationId: "retired", orgSlug: "fixture" } });
    expect(action).not.toHaveBeenCalled();
  });

  it("validates native notification action payloads and focuses the app", async () => {
    const calls: string[] = [];
    window.__TAURI__ = {
      core: { invoke: async <T,>(command: string) => {
        calls.push(command);
        return null as T;
      } },
    };
    const action = vi.fn();
    const unlisten = await listenForDesktopNotificationActions(action);

    nativeNotifications.action?.({ extra: { orgSlug: "faithfire-production" } });
    nativeNotifications.action?.({
      extra: {
        notificationId: "notice-2",
        orgSlug: "faithfire-production",
        actionUrl: "chat?room=production",
      },
    });
    await focusDesktopMainWindow();
    unlisten();

    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith({
      notificationId: "notice-2",
      orgSlug: "faithfire-production",
      actionUrl: "chat?room=production",
    });
    expect(calls).toEqual(["focus_main_window"]);
    expect(nativeNotifications.unregister).toHaveBeenCalledOnce();
  });

  it("checks an available Desktop update without installing or restarting", async () => {
    const invoke = vi.fn();
    window.__TAURI__ = { core: { invoke } };
    nativeUpdater.available = { version: "0.2.0" };
    await expect(checkDesktopUpdate()).resolves.toEqual({ version: "0.2.0", notes: null, date: null });
    expect(nativeUpdater.install).not.toHaveBeenCalled();
    expect(nativeUpdater.close).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not install or restart when the native updater has no update", async () => {
    const invoke = vi.fn();
    window.__TAURI__ = { core: { invoke } };
    await expect(checkDesktopUpdate()).resolves.toBeNull();
    await expect(installDesktopUpdate()).resolves.toBeNull();
    expect(nativeUpdater.install).not.toHaveBeenCalled();
    expect(nativeUpdater.close).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("checks, installs, closes, and restarts signed desktop updates", async () => {
    const calls: string[] = [];
    window.__TAURI__ = {
      core: { invoke: async <T,>(command: string) => {
        calls.push(command);
        return null as T;
      } },
    };
    nativeUpdater.available = {
      version: "0.2.0",
      body: "Device stability update",
      date: "2026-08-22T20:00:00.000Z",
    };

    await expect(checkDesktopUpdate()).resolves.toEqual({
      version: "0.2.0",
      notes: "Device stability update",
      date: "2026-08-22T20:00:00.000Z",
    });
    await expect(installDesktopUpdate()).resolves.toMatchObject({ version: "0.2.0" });

    expect(nativeUpdater.install).toHaveBeenCalledOnce();
    expect(nativeUpdater.close).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["restart_desktop"]);
  });

  it("reports a successful install needing manual restart on older shells", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue("Command restart_desktop not allowed by ACL") } };
    nativeUpdater.available = { version: "0.1.5" };
    await expect(installDesktopUpdate()).resolves.toMatchObject({ version: "0.1.5", restartRequired: true });
    expect(nativeUpdater.install).toHaveBeenCalledOnce();
    expect(nativeUpdater.close).toHaveBeenCalledOnce();
  });

  it("does not report an installed update when the download or installation fails", async () => {
    const invoke = vi.fn();
    window.__TAURI__ = { core: { invoke } };
    nativeUpdater.available = { version: "0.1.5" };
    nativeUpdater.install.mockRejectedValueOnce(new Error("Signature verification failed"));
    await expect(installDesktopUpdate()).rejects.toThrow("Signature verification failed");
    expect(nativeUpdater.close).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not let resource cleanup conceal the original installation failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      window.__TAURI__ = { core: { invoke: vi.fn() } };
      nativeUpdater.available = { version: "0.2.0" };
      nativeUpdater.install.mockRejectedValueOnce(new Error("Signature verification failed"));
      nativeUpdater.close.mockRejectedValueOnce(new Error("Resource close failed"));
      await expect(installDesktopUpdate()).rejects.toThrow("Signature verification failed");
      expect(window.__TAURI__.core!.invoke).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it("reports manual restart after a confirmed installation whose restart never replies", async () => {
    vi.useFakeTimers();
    window.__TAURI__ = { core: { invoke: vi.fn(() => new Promise<never>(() => {})) } };
    nativeUpdater.available = { version: "0.2.0" };
    const result = installDesktopUpdate();
    await vi.advanceTimersByTimeAsync(12000);
    await expect(result).resolves.toMatchObject({ version: "0.2.0", restartRequired: true });
    expect(nativeUpdater.install).toHaveBeenCalledExactlyOnceWith(undefined, { timeout: 120000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a known update after its resource close deadline instead of hanging the check", async () => {
    vi.useFakeTimers(); const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      window.__TAURI__ = { core: { invoke: vi.fn() } };
      nativeUpdater.available = { version: "0.2.0" };
      nativeUpdater.close.mockImplementationOnce(() => new Promise(() => {}));
      const result = checkDesktopUpdate();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(result).resolves.toMatchObject({ version: "0.2.0" });
      expect(nativeUpdater.install).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { warning.mockRestore(); }
  });

});
