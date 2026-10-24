import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusBar } from "../DesktopStatusBar";
import type { DesktopBridgeStatus } from "@/lib/desktop-runtime";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getBridgeStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openWindow: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "faithfire-production" }),
}));

vi.mock("@/lib/desktop-local-devices", () => ({
  configureDesktopLocalDevices: mocks.configure,
}));

vi.mock("@/lib/desktop-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop-runtime")>();
  return {
    ...actual,
    checkDesktopUpdate: mocks.checkUpdate,
    getDesktopBridgeStatus: mocks.getBridgeStatus,
    getDesktopEngineInfo: vi.fn().mockResolvedValue({
      native: true,
      platform: "macos",
      version: "0.1.0",
      cachePath: null,
    }),
    installDesktopUpdate: mocks.installUpdate,
    isDesktopRuntime: () => true,
    openDesktopWindow: mocks.openWindow,
    stopDesktopBridge: vi.fn().mockResolvedValue(undefined),
  };
});

describe("DesktopStatusBar", () => {
  beforeEach(() => {
    mocks.configure.mockReset();
    mocks.getBridgeStatus.mockReset().mockResolvedValue({ configured: false, running: false, connection: "offline", pid: null, logs: [], lastError: null });
    mocks.checkUpdate.mockReset().mockResolvedValue(null);
    mocks.installUpdate.mockReset().mockResolvedValue({ version: "0.1.4", notes: null, date: null });
    mocks.openWindow.mockReset().mockResolvedValue(undefined);
  });

  it("confirms the switch and recognizes a legacy engine after it starts", async () => {
    let status: DesktopBridgeStatus = {
      configured: true,
      running: false,
      connection: "offline",
      pid: null,
      logs: [] as string[],
      lastError: null,
    };
    mocks.getBridgeStatus.mockImplementation(async () => status);
    mocks.configure.mockImplementation(async () => {
      status = {
        ...status,
        running: true,
        connection: "connected",
        pid: 1234,
      };
      return status;
    });

    render(<DesktopStatusBar />);
    await screen.findByText("Venue Bridge mode");

    fireEvent.click(screen.getByRole("button", { name: "Use this computer" }));
    const dialog = await screen.findByRole("dialog");
    expect(mocks.configure).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Use this computer" }));

    await waitFor(() => {
      expect(mocks.configure).toHaveBeenCalledWith("faithfire-production", true);
      expect(screen.getByText("This computer controls local devices")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Use venue Bridge" })).not.toBeNull();
    });
  });

  it("uses an app dialog to install even when native browser confirmation is unavailable", async () => {
    const browserConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.checkUpdate.mockResolvedValue({ version: "0.1.4", notes: null, date: null });
    render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update 0.1.4" }));
    const dialog = await screen.findByRole("dialog");
    expect(mocks.installUpdate).not.toHaveBeenCalled();
    expect(browserConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
    browserConfirm.mockRestore();
  });

  it("does not install when the operator cancels the update", async () => {
    mocks.checkUpdate.mockResolvedValue({ version: "0.1.4", notes: null, date: null });
    render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update 0.1.4" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.installUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Update 0.1.4" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows native window failures even when the engine is connected", async () => {
    mocks.openWindow.mockRejectedValue("Window permission denied");
    render(<DesktopStatusBar />);
    await screen.findByText("Local engine 0.1.0 · macos");
    fireEvent.click(screen.getByRole("button", { name: "Check-in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Window permission denied");
    expect(mocks.openWindow).toHaveBeenCalledWith("check-in", "faithfire-production");
    expect(screen.getByRole("button", { name: "Check-in" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows an installation failure and allows retrying", async () => {
    mocks.checkUpdate.mockResolvedValue({ version: "0.1.4", notes: null, date: null });
    mocks.installUpdate.mockRejectedValue("Could not write the application bundle");
    render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update 0.1.4" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install and restart" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not write the application bundle");
    expect(screen.getByRole("button", { name: "Update 0.1.4" }).hasAttribute("disabled")).toBe(false);
  });

  it("explains how to finish an installed update when the old shell cannot restart", async () => {
    mocks.checkUpdate.mockResolvedValue({ version: "0.1.5", notes: null, date: null });
    mocks.installUpdate.mockResolvedValue({ version: "0.1.5", notes: null, date: null, restartRequired: true });
    render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update 0.1.5" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install and restart" }));
    expect((await screen.findByRole("status")).textContent).toContain("Update installed. Choose Quit ShowPilot");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Restart required" }).hasAttribute("disabled")).toBe(true);
  });

});
