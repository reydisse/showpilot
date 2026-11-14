import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusBar } from "../DesktopStatusBar";
import type { DesktopBridgeStatus } from "@/lib/desktop-runtime";

const mocks = vi.hoisted(() => ({
  native: true,
  slug: "faithfire-production",
  configure: vi.fn(),
  getBridgeStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openWindow: vi.fn(),
  openLocalShow: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: mocks.slug }),
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
    isDesktopRuntime: () => mocks.native,
    openDesktopWindow: mocks.openWindow,
    openDesktopLocalShow: mocks.openLocalShow,
    stopDesktopBridge: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  mocks.native = true;
  mocks.slug = "faithfire-production";
  mocks.configure.mockReset();
  mocks.openLocalShow.mockReset().mockResolvedValue(undefined);
  mocks.getBridgeStatus.mockReset().mockResolvedValue({ configured: false, running: false, connection: "offline", pid: null, logs: [], lastError: null });
  mocks.checkUpdate.mockReset().mockResolvedValue(null);
  mocks.installUpdate.mockReset().mockResolvedValue({ version: "0.1.4", notes: null, date: null });
  mocks.openWindow.mockReset().mockResolvedValue(undefined);
});

describe("DesktopStatusBar", () => {
  it("hydrates the server page before adding native controls without replacing the operator tree", async () => {
    const element = <div><button>Keep operator state</button><DesktopStatusBar /></div>;
    mocks.native = false;
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    const existing = container.querySelector("button");
    expect(container.textContent).not.toContain("Check update");
    mocks.native = true;
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, element, { onRecoverableError }); });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(container.querySelector("button")).toBe(existing);
      expect(within(container).getByRole("button", { name: "Check update" })).toBeTruthy();
      fireEvent.click(within(container).getByRole("button", { name: "Check-in" }));
      await waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("check-in", "faithfire-production"));
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
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

    await waitFor(() => expect(screen.getByRole("button", { name: "Use this computer" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Use this computer" }));
    const dialog = await screen.findByRole("dialog");
    expect(mocks.configure).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Use this computer" }));

    await waitFor(() => {
      expect(mocks.configure).toHaveBeenCalledWith("faithfire-production", true, expect.any(Function));
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

it("opens the native local workspace and surfaces older-engine failures", async () => {
  mocks.openLocalShow.mockRejectedValueOnce(new Error("Unsupported command"));
  render(<DesktopStatusBar />);
  fireEvent.click(screen.getByRole("button", { name: "Local show" }));
  await screen.findByText("The local workspace could not open. Update ShowPilot Desktop and try again.");
  expect(mocks.openLocalShow).toHaveBeenCalledTimes(1);
});


afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  else await new Promise(resolve => setTimeout(resolve, 0));
  vi.useRealTimers();
});
it("moves secondary actions into a keyboard-accessible dropdown while window controls remain outside it", async () => {
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observers.set(element, this.callback); }
    disconnect() {}
  });
  try {
    mocks.slug = "showpilot-demo-nov04";
    render(<DesktopStatusBar />);
    const region = screen.getByRole("region", { name: "Desktop controls" });
    const resize = (width: number) => act(() => {
      observers.get(region)!([{ target: region, contentRect: new DOMRect(0, 0, width, 44), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver);
    });
    resize(860);
    expect(screen.queryByRole("button", { name: "Local show" })).toBeNull();
    for (const label of ["Crew status", "Check-in"]) {
      expect(screen.getByRole("button", { name: label }).closest('[role="dialog"]')).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Desktop actions" }));
    const dropdown = await screen.findByRole("dialog", { name: "Desktop actions" });
    expect(within(dropdown).getByRole("button", { name: "Timer window" })).toBeTruthy();
    expect((await screen.findByRole("button", { name: "Confidence output and appearance" })).closest('[role="dialog"]')).toBeNull();
    fireEvent.click(within(dropdown).getByRole("button", { name: "Local show" }));
    await waitFor(() => expect(mocks.openLocalShow).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Check-in" }));
    await waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("check-in", "showpilot-demo-nov04"));
    const timer = within(dropdown).getByRole("button", { name: "Timer window" });
    await waitFor(() => expect(timer.hasAttribute("disabled")).toBe(false));
    fireEvent.click(timer);
    await waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("timer", "showpilot-demo-nov04"));
    let finishCheck: (value: null) => void = () => {};
    const checks = mocks.checkUpdate.mock.calls.length;
    mocks.checkUpdate.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    fireEvent.click(within(dropdown).getByRole("button", { name: /Check update|Up to date/ }));
    await waitFor(() => expect(mocks.checkUpdate).toHaveBeenCalledTimes(checks + 1));
    fireEvent.keyDown(dropdown, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Desktop actions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Desktop actions" })));
    resize(1600);
    expect(screen.queryByRole("button", { name: "Desktop actions" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Local show" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Checking…" }).hasAttribute("disabled")).toBe(true);
    resize(860);
    fireEvent.click(screen.getByRole("button", { name: "Desktop actions" }));
    await screen.findByRole("dialog", { name: "Desktop actions" });
    expect(screen.getByRole("button", { name: "Checking…" }).hasAttribute("disabled")).toBe(true);
    expect(mocks.checkUpdate).toHaveBeenCalledTimes(checks + 1);
    await act(async () => finishCheck(null));
    await screen.findByRole("button", { name: "Up to date" });
    expect(mocks.openLocalShow).toHaveBeenCalledTimes(1);
    expect(mocks.openWindow).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("does not overlap a stalled Bridge status read", async () => {
  vi.useFakeTimers(); mocks.native = true;
  mocks.getBridgeStatus.mockReturnValue(new Promise(() => {}));
  render(<DesktopStatusBar />);
  await act(() => vi.advanceTimersByTimeAsync(16000));
  expect(mocks.getBridgeStatus).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Local device status unavailable")).toBeTruthy();
});
it("reports an unresolved native window without allowing duplicate opens", async () => {
  vi.useFakeTimers(); mocks.native = true;
  let finish!: () => void; mocks.openWindow.mockReturnValue(new Promise<void>(done => { finish = done; }));
  render(<DesktopStatusBar />);
  fireEvent.click(screen.getByRole("button", { name: "Check-in" }));
  await act(() => vi.advanceTimersByTimeAsync(12000));
  expect(screen.getByText(/Check-in has not confirmed/)).toBeTruthy();
  expect(mocks.openWindow).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Check-in" }).hasAttribute("disabled")).toBe(false);
});
it("does not apply a local-device confirmation from the preceding workspace", async () => {
  mocks.native = true; mocks.slug = "faithfire-production"; mocks.configure.mockReset();
  mocks.getBridgeStatus.mockResolvedValue({ configured: false, running: false, connection: "offline", pid: null, logs: [], lastError: null });
  const view = render(<DesktopStatusBar />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this computer" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Use this computer" }));
  const dialog = await screen.findByRole("dialog");
  mocks.slug = "other-workspace"; view.rerender(<DesktopStatusBar />);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use this computer" }));
  await act(async () => {});
  expect(mocks.configure).not.toHaveBeenCalled();
});

it("retains a slow installation across remounts and accepts its late confirmed result", async () => {
  vi.useFakeTimers();
  mocks.checkUpdate.mockResolvedValue({ version: "0.2.0", notes: null, date: null });
  let finish!: (value: { version: string; restartRequired: boolean }) => void;
  mocks.installUpdate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<DesktopStatusBar />);
  fireEvent.click(screen.getByRole("button", { name: "Check update" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  fireEvent.click(screen.getByRole("button", { name: "Update 0.2.0" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install and restart" }));
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(screen.getByText(/Desktop installation has not confirmed completion/)).toBeTruthy();
  view.unmount(); render(<DesktopStatusBar />);
  const button = screen.getByRole("button", { name: "Installation not confirmed" });
  expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button);
  expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ version: "0.2.0", restartRequired: true }));
  expect(screen.getByRole("button", { name: "Restart required" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText(/Desktop installation has not confirmed completion/)).toBeNull();
});

it("ignores an older status reply after an explicit retry reads newer state", async () => {
  vi.useFakeTimers();
  let finish!: (value: DesktopBridgeStatus) => void;
  mocks.getBridgeStatus.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const connected: DesktopBridgeStatus = { configured: true, running: true, connection: "connected", localDevicesEnabled: true, pid: 1, logs: [], lastError: null };
  mocks.getBridgeStatus.mockResolvedValue(connected);
  render(<DesktopStatusBar />);
  await act(() => vi.advanceTimersByTimeAsync(12000));
  fireEvent.click(screen.getByRole("button", { name: "Retry local status" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText("This computer controls local devices")).toBeTruthy();
  await act(async () => finish({ ...connected, connection: "offline", running: false, localDevicesEnabled: false }));
  expect(screen.getByText("This computer controls local devices")).toBeTruthy();
});

it("does not let the scheduled update check overlap a manual check", async () => {
  vi.useFakeTimers();
  let finish!: (value: { version: string; notes: null; date: null }) => void;
  mocks.checkUpdate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<DesktopStatusBar />);
  fireEvent.click(screen.getByRole("button", { name: "Check update" }));
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(mocks.checkUpdate).toHaveBeenCalledTimes(1);
  await act(async () => finish({ version: "0.2.0", notes: null, date: null }));
  expect(screen.getByRole("button", { name: "Update 0.2.0" })).toBeTruthy();
});
