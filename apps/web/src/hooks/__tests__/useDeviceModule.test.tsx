import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceConnectionStatus,
  DeviceModule,
  FeedbackChangeCallback,
  StatusChangeCallback,
} from "@/lib/device-modules/types";
import { useDeviceModule } from "@/hooks/useDeviceModule";

const mocks = vi.hoisted(() => ({
  bridgeOnline: false,
  bridgeStatusListener: null as ((online: boolean, error?: string) => void) | null,
  createInstance: vi.fn(),
}));

vi.mock("@/lib/device-modules/register-all", () => ({}));

vi.mock("@/lib/device-modules/registry", () => {
  const definition = {
      adapterType: "test-bridge-device",
      displayName: "Test bridge device",
      category: "video",
      transport: "tcp",
      connectivity: "bridge-required",
      configFields: [],
      icon: "Monitor",
      description: "Test device",
      createInstance: mocks.createInstance,
  };
  return {
    moduleRegistry: {
      get: () => definition,
    },
  };
});

vi.mock("@/lib/device-modules/bridge-proxy", () => ({
  getSharedBridgeProxy: () => ({
    isBridgeOnline: () => mocks.bridgeOnline,
    getLastError: () => null,
    onBridgeStatus: (listener: (online: boolean, error?: string) => void) => {
      mocks.bridgeStatusListener = listener;
      return () => {
        if (mocks.bridgeStatusListener === listener) mocks.bridgeStatusListener = null;
      };
    },
  }),
}));

class FakeDeviceModule implements DeviceModule {
  private status: DeviceConnectionStatus = "disconnected";
  private statusListeners = new Set<StatusChangeCallback>();

  async connect() {
    if (this.status === "connected") return;
    this.emitStatus("connecting");
    await Promise.resolve();
    this.emitStatus("connected");
  }

  disconnect() {
    this.emitStatus("disconnected");
  }

  connectionStatus() {
    return this.status;
  }

  onStatusChange(callback: StatusChangeCallback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  getActions() {
    return [];
  }

  async executeAction() {}

  getFeedbacks() {
    return [];
  }

  onFeedbackChange(_callback: FeedbackChangeCallback) {
    return () => {};
  }

  private emitStatus(status: DeviceConnectionStatus) {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

const device = {
  id: "device-1",
  adapterType: "test-bridge-device",
  settings: "{}",
  enabled: true,
};

describe("useDeviceModule", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  beforeEach(() => {
    mocks.bridgeOnline = false;
    mocks.bridgeStatusListener = null;
    mocks.createInstance.mockReset();
    mocks.createInstance.mockImplementation(() => new FakeDeviceModule());
  });

  it("keeps a connected device connected when the Bridge sends its next status heartbeat", async () => {
    const { result } = renderHook(() => useDeviceModule(device, "org-1"));

    expect(result.current.status).toBe("bridge-required");

    await act(async () => {
      mocks.bridgeOnline = true;
      mocks.bridgeStatusListener?.(true);
    });
    await waitFor(() => expect(result.current.status).toBe("connected"));

    act(() => mocks.bridgeStatusListener?.(true));

    expect(result.current.status).toBe("connected");
  });

  it("keeps the Bridge failure reason visible and clears it after reconnection", async () => {
    mocks.bridgeOnline = true;
    const { result } = renderHook(() => useDeviceModule(device, "org-1"));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    act(() => { mocks.bridgeOnline = false; mocks.bridgeStatusListener?.(false, "Venue Bridge disconnected"); });
    expect(result.current.status).toBe("bridge-required");
    expect(result.current.error).toBe("Venue Bridge disconnected");
    await act(async () => { mocks.bridgeOnline = true; mocks.bridgeStatusListener?.(true); });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.error).toBeNull();
  });

  it("returns visible feedback instead of silently ignoring Connect before controls are ready", async () => {
    const { result } = renderHook(() => useDeviceModule(device, "org-1"));

    await act(async () => result.current.connect());

    expect(result.current.status).toBe("bridge-required");
    expect(result.current.error).toContain("Venue Bridge is offline");
  });

  it("publishes a module for a device with auto-connect disabled", async () => {
    mocks.bridgeOnline = true;
    const { result } = renderHook(() => useDeviceModule({ ...device, enabled: false }, "org-1"));
    await waitFor(() => expect(result.current.module).not.toBeNull());
    expect(result.current.status).toBe("disconnected");
    await act(async () => result.current.connect());
    expect(result.current.status).toBe("connected");
  });

  it("shows a rejected connection attempt and allows a retry", async () => {
    mocks.bridgeOnline = true;
    const module = new FakeDeviceModule();
    const connect = vi.spyOn(module, "connect").mockRejectedValueOnce(new Error("Device refused connection"));
    mocks.createInstance.mockReturnValue(module);
    const { result } = renderHook(() => useDeviceModule(device, "org-1"));
    await waitFor(() => expect(result.current.error).toBe("Device refused connection"));
    expect(result.current.status).toBe("error");
    await act(async () => result.current.connect());
    expect(connect).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBeNull();
  });

  it.each(['{broken', 'null', '[]', '"host"'])("blocks invalid settings %s and clears the error after repair", async (settings) => {
    mocks.bridgeOnline = true;
    const { result, rerender } = renderHook(({ settings }) => useDeviceModule({ ...device, enabled: false, settings }, "org-1"), { initialProps: { settings } });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("settings could not be read");
    expect(result.current.errorAt).toEqual(expect.any(Number));
    expect(result.current.module).toBeNull();
    expect(mocks.createInstance).not.toHaveBeenCalled();
    await act(async () => result.current.connect());
    expect(result.current.error).toContain("settings could not be read");
    rerender({ settings: '{"host":"venue"}' });
    await waitFor(() => expect(result.current.module).not.toBeNull());
    expect(result.current.status).toBe("disconnected");
    expect(result.current.error).toBeNull();
    expect(result.current.errorAt).toBeNull();
    expect(mocks.createInstance).toHaveBeenCalledWith({ host: "venue", orgId: "org-1" });
  });

  it("surfaces a module construction failure and recovers after editing settings", async () => {
    mocks.bridgeOnline = true;
    mocks.createInstance.mockImplementationOnce(() => { throw new Error("bad adapter configuration"); });
    const { result, rerender } = renderHook(({ settings }) => useDeviceModule({ ...device, settings }, "org-1"), { initialProps: { settings: "{}" } });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("Device controls could not start");
    expect(result.current.errorAt).toEqual(expect.any(Number));
    rerender({ settings: '{"host":"repaired"}' });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.errorAt).toBeNull();
  });

  it("ignores late rejected connections, callbacks, and saved controls from the previous organization", async () => {
    mocks.bridgeOnline = true;
    let rejectOld: (error: Error) => void = () => { throw new Error("old connection was not started"); };
    const oldModule = new FakeDeviceModule();
    vi.spyOn(oldModule, "connect").mockImplementation(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    mocks.createInstance.mockReturnValueOnce(oldModule);
    const { result, rerender } = renderHook(({ orgId }) => useDeviceModule(device, orgId), { initialProps: { orgId: "org-1" } });
    await waitFor(() => expect(result.current.module).toBe(oldModule));
    const oldBridgeListener = mocks.bridgeStatusListener;
    const oldConnect = result.current.connect;
    const oldDisconnect = result.current.disconnect;
    mocks.bridgeOnline = false;
    rerender({ orgId: "org-2" });
    expect(result.current.module).toBeNull();
    expect(result.current.bridgeOnline).toBe(false);
    expect(result.current.status).toBe("bridge-required");
    await act(async () => {
      rejectOld(new Error("old device failed"));
      oldBridgeListener?.(true, "old Bridge failed");
      await oldConnect(); oldDisconnect();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.bridgeOnline).toBe(false);
    expect(mocks.createInstance).toHaveBeenCalledTimes(1);
    await act(async () => { mocks.bridgeOnline = true; mocks.bridgeStatusListener?.(true); });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.module).not.toBe(oldModule);
  });

  it("reports an explicit disconnect failure with a timestamp", async () => {
    mocks.bridgeOnline = true;
    const module = new FakeDeviceModule();
    mocks.createInstance.mockReturnValue(module);
    const { result } = renderHook(() => useDeviceModule(device, "org-1"));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    vi.spyOn(module, "disconnect").mockImplementationOnce(() => { throw new Error("network failure"); });
    act(() => result.current.disconnect());
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("disconnect could not be confirmed");
    expect(result.current.errorAt).toEqual(expect.any(Number));
  });

});
