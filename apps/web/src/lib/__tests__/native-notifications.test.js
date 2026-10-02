import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constants: { expoConfig: { extra: { eas: { projectId: "project-123" } } } },
  device: { isDevice: true },
  platform: { OS: "ios" },
  permissions: vi.fn(),
  request: vi.fn(),
  token: vi.fn(),
  channel: vi.fn(),
}));
vi.mock("expo-constants", () => ({ default: mocks.constants }));
vi.mock("expo-device", () => mocks.device);
vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: mocks.permissions,
  requestPermissionsAsync: mocks.request,
  getExpoPushTokenAsync: mocks.token,
  setNotificationChannelAsync: mocks.channel,
  AndroidImportance: { HIGH: 4 },
}));
import { registerNativeNotifications, enableNativeNotifications } from "../../../../mobile/src/lib/native-notifications";

describe("native push permission and registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.constants.expoConfig.extra.eas.projectId = "project-123";
    mocks.device.isDevice = true;
    mocks.platform.OS = "ios";
    mocks.permissions.mockResolvedValue({ status: "granted", canAskAgain: true });
    mocks.request.mockResolvedValue({ status: "granted", canAskAgain: true });
    mocks.token.mockResolvedValue({ data: "ExpoPushToken[test-device-token]" });
    mocks.channel.mockResolvedValue(undefined);
  });

  it("requests alerts on the first authenticated registration and uses the linked project", async () => {
    mocks.permissions.mockResolvedValue({ status: "undetermined", canAskAgain: true });
    expect(await registerNativeNotifications(true)).toBe("ExpoPushToken[test-device-token]");
    expect(mocks.request).toHaveBeenCalledWith({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    expect(mocks.token).toHaveBeenCalledWith({ projectId: "project-123" });
  });

  it("respects a denial without prompting repeatedly or minting a push token", async () => {
    mocks.permissions.mockResolvedValue({ status: "denied", canAskAgain: false });
    expect(await registerNativeNotifications(true)).toBeNull();
    expect(await registerNativeNotifications(true)).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("does not register after the user declines the first permission prompt", async () => {
    mocks.permissions.mockResolvedValue({ status: "undetermined", canAskAgain: true });
    mocks.request.mockResolvedValue({ status: "denied", canAskAgain: false });
    expect(await registerNativeNotifications(true)).toBeNull();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("refreshes the token without prompting when notifications are already allowed", async () => {
    expect(await registerNativeNotifications(true)).toBe("ExpoPushToken[test-device-token]");
    mocks.token.mockResolvedValue({ data: "ExpoPushToken[rotated-device-token]" });
    expect(await registerNativeNotifications(true)).toBe("ExpoPushToken[rotated-device-token]");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("surfaces registration failures so the lifecycle can retry", async () => {
    mocks.token.mockRejectedValueOnce(new Error("APNs temporarily unavailable"));
    await expect(registerNativeNotifications(true)).rejects.toThrow("APNs temporarily unavailable");
    expect(await registerNativeNotifications(true)).toBe("ExpoPushToken[test-device-token]");
  });

  it("does not ask permission without a configured push project", async () => {
    mocks.constants.expoConfig.extra.eas.projectId = undefined;
    expect(await registerNativeNotifications(true)).toBeNull();
    expect(mocks.permissions).not.toHaveBeenCalled();
    await expect(enableNativeNotifications()).rejects.toThrow("Device alerts are not available");
  });

  it("creates the Android notification channel before asking for permission", async () => {
    mocks.platform.OS = "android";
    mocks.permissions.mockResolvedValue({ status: "undetermined", canAskAgain: true });
    await registerNativeNotifications(true);
    expect(mocks.channel.mock.invocationCallOrder[0]).toBeLessThan(mocks.request.mock.invocationCallOrder[0]);
  });
});
