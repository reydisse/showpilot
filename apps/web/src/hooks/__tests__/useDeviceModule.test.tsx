import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceConnectionStatus,
  DeviceModule,
  FeedbackChangeCallback,
  StatusChangeCallback,
} from "@/lib/device-modules/types";
import { useDeviceModule } from "@/hooks/useDeviceModule";

const mocks = vi.hoisted(() => ({
  bridgeOnline: false,
  bridgeStatusListener: null as ((online: boolean) => void) | null,
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
    onBridgeStatus: (listener: (online: boolean) => void) => {
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
});
