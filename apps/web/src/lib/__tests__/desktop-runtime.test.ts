import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeNotifications = vi.hoisted(() => ({
  granted: false,
  sent: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => nativeNotifications.granted,
  requestPermission: async () => {
    nativeNotifications.granted = true;
    return "granted" as const;
  },
  sendNotification: (options: { title: string; body?: string }) => {
    nativeNotifications.sent.push(options);
  },
}));
import {
  cacheDesktopService,
  getDesktopBridgeStatus,
  getDesktopFullscreenState,
  getDesktopEngineInfo,
  getDesktopNotificationPermission,
  isDesktopRuntime,
  isDesktopNotificationSupported,
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
  nativeNotifications.sent.length = 0;
});

afterEach(() => {
  window.__TAURI__ = originalTauri;
});

describe("desktop runtime boundary", () => {
  it("stays inert in a normal browser", async () => {
    window.__TAURI__ = undefined;
    expect(isDesktopRuntime()).toBe(false);
    expect(isDesktopNotificationSupported()).toBe(false);
    await expect(getDesktopEngineInfo()).resolves.toBeNull();
    await expect(cacheDesktopService({ id: "show-1" })).resolves.toBeNull();
    await expect(getDesktopBridgeStatus()).resolves.toBeNull();
    await expect(requestDesktopNotificationPermission()).resolves.toBe("denied");
    await expect(getDesktopNotificationPermission()).resolves.toBe("denied");
    await expect(showDesktopNotification("Test", "Body")).resolves.toBe(false);
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
      { config: { site: "https://showpilot.tech", org: "faithfire-production", key: "sp_test" } },
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

});
