import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridgeStatus } from "../desktop-runtime";

const mocks = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), context: vi.fn(), settings: vi.fn(), issue: vi.fn(), revoke: vi.fn() }));
vi.mock("../desktop-runtime", () => ({
  getDesktopBridgeStatus: mocks.status,
  startDesktopBridge: mocks.start,
  isDesktopLocalDeviceMode: (status: DesktopBridgeStatus) => status.localDevicesEnabled,
}));
vi.mock("../session", () => ({ getOrgRouteContext: mocks.context }));
vi.mock("../settings", () => ({ getDesktopBridgeAccess: mocks.settings }));
vi.mock("../bridge-installations", () => ({ createBridgeInstallation: mocks.issue, revokeBridgeInstallationKey: mocks.revoke }));
import { configureDesktopLocalDevices } from "../desktop-local-devices";

function status(overrides: Partial<DesktopBridgeStatus> = {}): DesktopBridgeStatus {
  return { configured: true, secureCredentials: true, configuredSite: window.location.origin,
    configuredOrg: "venue", localDevicesEnabled: true, running: true, connection: "connected", pid: 1,
    logs: [], lastError: null, ...overrides };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue(status());
  mocks.context.mockResolvedValue({ org: { id: "org-1" } });
  mocks.settings.mockResolvedValue({ orgId: "org-1" });
  mocks.issue.mockResolvedValue({ installationId: "install-1", credentialId: "credential-1", key: "sp_one_time" });
  mocks.start.mockResolvedValue(status());
});
describe("Desktop installation credentials", () => {
  it("reuses the native saved key without issuing a replacement on reconnect", async () => {
    await configureDesktopLocalDevices("venue");
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith({ site: window.location.origin, org: "venue", key: "" });
  });
  it("provisions a key only when the operator enables a new local installation", async () => {
    mocks.status.mockResolvedValue(status({ configured: false, localDevicesEnabled: false, configuredOrg: null }));
    await configureDesktopLocalDevices("venue");
    expect(mocks.issue).not.toHaveBeenCalled();
    await configureDesktopLocalDevices("venue", true);
    expect(mocks.issue).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", label: "ShowPilot Desktop" } });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ key: "sp_one_time" }));
  });
  it("does not change the running Bridge when another workspace opens", async () => {
    await configureDesktopLocalDevices("other-venue");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("does not automatically bypass a revoked key", async () => {
    mocks.status.mockResolvedValue(status({ connection: "unauthorized" }));
    await expect(configureDesktopLocalDevices("venue")).rejects.toThrow("no longer authorized");
    expect(mocks.issue).not.toHaveBeenCalled();
    await configureDesktopLocalDevices("venue", true);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });
  it("requires an updated native engine before sending a new credential", async () => {
    mocks.status.mockResolvedValue(status({ secureCredentials: undefined }));
    await expect(configureDesktopLocalDevices("venue", true)).rejects.toThrow("Update ShowPilot Desktop");
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("revokes an unused key if navigation cancels provisioning", async () => {
    mocks.status.mockResolvedValue(status({ configured: false }));
    let active = true;
    mocks.issue.mockImplementation(async () => { active = false; return { installationId: "install-1", key: "sp_one_time" }; });
    await configureDesktopLocalDevices("venue", true, () => active);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", installationId: "install-1" } });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
