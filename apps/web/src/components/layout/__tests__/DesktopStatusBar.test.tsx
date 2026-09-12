import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusBar } from "../DesktopStatusBar";
import type { DesktopBridgeStatus } from "@/lib/desktop-runtime";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getBridgeStatus: vi.fn(),
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
    checkDesktopUpdate: vi.fn().mockResolvedValue(null),
    getDesktopBridgeStatus: mocks.getBridgeStatus,
    getDesktopEngineInfo: vi.fn().mockResolvedValue({
      native: true,
      platform: "macos",
      version: "0.1.0",
      cachePath: null,
    }),
    installDesktopUpdate: vi.fn().mockResolvedValue(null),
    isDesktopRuntime: () => true,
    openDesktopWindow: vi.fn().mockResolvedValue(undefined),
    stopDesktopBridge: vi.fn().mockResolvedValue(undefined),
  };
});

describe("DesktopStatusBar local-device mode", () => {
  beforeEach(() => {
    mocks.configure.mockReset();
    mocks.getBridgeStatus.mockReset();
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
});
