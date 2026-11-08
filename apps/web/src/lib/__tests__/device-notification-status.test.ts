import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceNotificationStatus } from "../device-notification-status";

const api = vi.hoisted(() => ({
  native: vi.fn(),
  permission: vi.fn(),
  enable: vi.fn(),
}));
vi.mock("../desktop-runtime", () => ({
  isDesktopNotificationSupported: api.native,
  getDesktopNotificationPermission: api.permission,
}));
vi.mock("../notifications", () => ({ enablePushForOrg: api.enable }));
beforeEach(() => {
  vi.clearAllMocks();
  api.native.mockReturnValue(false);
  vi.stubGlobal("Notification", { permission: "default" });
});
afterEach(() => vi.unstubAllGlobals());

it("does not prompt or subscribe while browser permission is undecided", async () => {
  expect(await readDeviceNotificationStatus("org-a")).toEqual({
    permission: "default",
    enabled: false,
  });
  expect(api.enable).not.toHaveBeenCalled();
});
it("checks the current org without asking for permission again", async () => {
  vi.stubGlobal("Notification", { permission: "granted" });
  api.enable.mockResolvedValueOnce("granted");
  expect(await readDeviceNotificationStatus("org-a")).toEqual({
    permission: "granted",
    enabled: true,
  });
  expect(api.enable).toHaveBeenCalledWith("org-a", false);
});
it("does not call delivery enabled when subscription setup could not finish", async () => {
  vi.stubGlobal("Notification", { permission: "granted" });
  api.enable.mockResolvedValueOnce("denied");
  expect(await readDeviceNotificationStatus("org-a")).toEqual({
    permission: "granted",
    enabled: false,
  });
});
it("keeps a failed subscription check available to the recovery UI", async () => {
  vi.stubGlobal("Notification", { permission: "granted" });
  api.enable.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(readDeviceNotificationStatus("org-a")).rejects.toThrow(
    "Unavailable",
  );
});
it("uses native permission without browser subscription setup", async () => {
  api.native.mockReturnValue(true);
  api.permission.mockResolvedValueOnce("granted");
  expect(await readDeviceNotificationStatus("org-a")).toEqual({
    permission: "granted",
    enabled: true,
  });
  expect(api.enable).not.toHaveBeenCalled();
});
it("propagates failed native status checks", async () => {
  api.native.mockReturnValue(true);
  api.permission.mockRejectedValueOnce(new Error("Native status unavailable"));
  await expect(readDeviceNotificationStatus("org-a")).rejects.toThrow(
    "Native status unavailable",
  );
});
