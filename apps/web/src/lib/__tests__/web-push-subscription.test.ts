import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  desktopPermission: vi.fn(),
  desktopRequest: vi.fn(),
  configuration: vi.fn(),
  save: vi.fn(),
  prompt: vi.fn(),
  register: vi.fn(),
  existing: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopNotificationSupported: mocks.desktop,
  getDesktopNotificationPermission: mocks.desktopPermission,
  requestDesktopNotificationPermission: mocks.desktopRequest,
  showDesktopNotification: vi.fn(),
}));
vi.mock("@/lib/push-notifications", () => ({
  getPushConfiguration: mocks.configuration,
  savePushSubscription: mocks.save,
}));
import { enablePushForOrg } from "../notifications";

const subscription = {
  toJSON: () => ({
    endpoint: "https://push.invalid/fixture",
    expirationTime: null,
    keys: { p256dh: "public-fixture", auth: "auth-fixture" },
  }),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.desktop.mockReturnValue(false);
  mocks.prompt.mockResolvedValue("granted");
  mocks.configuration.mockResolvedValue({ supported: true, publicKey: "AQID" });
  mocks.save.mockResolvedValue({ ok: true });
  mocks.existing.mockResolvedValue(null);
  mocks.subscribe.mockResolvedValue(subscription);
  mocks.register.mockResolvedValue({
    pushManager: {
      getSubscription: mocks.existing,
      subscribe: mocks.subscribe,
    },
  });
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: mocks.prompt,
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("navigator", { serviceWorker: { register: mocks.register } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Web Push setup after permission", () => {
  it("requests permission in the initiating call before loading subscription setup", async () => {
    const operation = enablePushForOrg("org-a");
    expect(mocks.prompt).toHaveBeenCalledOnce();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.configuration).not.toHaveBeenCalled();
    expect(await operation).toBe("granted");
    expect(mocks.configuration).toHaveBeenCalledWith({
      data: { orgId: "org-a" },
    });
    expect(mocks.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(mocks.save).toHaveBeenCalledWith({
      data: { orgId: "org-a", ...subscription.toJSON() },
    });
  });
  it("does not register or persist a subscription when the user declines", async () => {
    mocks.prompt.mockResolvedValue("denied");
    expect(await enablePushForOrg("org-a")).toBe("denied");
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.configuration).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reuses an existing subscription without prompting during a status refresh", async () => {
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: mocks.prompt,
    });
    mocks.existing.mockResolvedValue(subscription);
    expect(await enablePushForOrg("org-b", false)).toBe("granted");
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith({
      data: { orgId: "org-b", ...subscription.toJSON() },
    });
  });
  it("reports configuration and persistence errors without claiming enrollment", async () => {
    mocks.configuration.mockResolvedValueOnce({ supported: false });
    await expect(enablePushForOrg("org-a")).rejects.toThrow("not configured");
    expect(mocks.subscribe).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new Error("Subscription save failed"));
    await expect(enablePushForOrg("org-a")).rejects.toThrow(
      "Subscription save failed",
    );
  });
  it("keeps Desktop permission handling independent of Web Push", async () => {
    mocks.desktop.mockReturnValue(true);
    mocks.desktopRequest.mockResolvedValue("granted");
    expect(await enablePushForOrg("org-a")).toBe("granted");
    expect(mocks.desktopRequest).toHaveBeenCalledOnce();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.configuration).not.toHaveBeenCalled();
  });
});
