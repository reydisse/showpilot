import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopShowSetup } from "@/components/settings/DesktopShowSetup";
import { DesktopStatusBar } from "../DesktopStatusBar";

const mocks = vi.hoisted(() => ({
  native: true,
  slug: "showpilot-demo-nov04",
  configure: vi.fn(),
  getBridgeStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openWindow: vi.fn(),
  openLocalShow: vi.fn(),
  localStatus: null as null | { mode: string; orgId: string; commandSource: string },
}));

vi.mock("@/hooks/useDesktopLocalShow", () => ({ useDesktopLocalShow: () => ({ status: mocks.localStatus, error: null }) }));
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
  mocks.localStatus = null;
  mocks.slug = "showpilot-demo-nov04";
  mocks.configure.mockReset();
  mocks.openLocalShow.mockReset().mockResolvedValue(undefined);
  mocks.getBridgeStatus.mockReset().mockResolvedValue({ configured: false, running: false, connection: "offline", pid: null, logs: [], lastError: null });
  mocks.checkUpdate.mockReset().mockResolvedValue(null);
  mocks.installUpdate.mockReset().mockResolvedValue({ version: "0.1.4", notes: null, date: null });
  mocks.openWindow.mockReset().mockResolvedValue(undefined);
});


const setup = () => <DesktopShowSetup orgId="org-1" slug={mocks.slug} />;
afterEach(async () => { cleanup(); if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("quiet Desktop toolbar", () => {
  it("hydrates native controls without replacing the mounted operator page", async () => {
    mocks.native = false;
    const element = <div><button>Keep operator state</button><DesktopStatusBar /></div>;
    const container = document.createElement("div"); container.innerHTML = renderToString(element); document.body.appendChild(container);
    const existing = container.querySelector("button"); const onRecoverableError = vi.fn(); mocks.native = true;
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try { await act(async () => { root = hydrateRoot(container, element, { onRecoverableError }); });
      expect(onRecoverableError).not.toHaveBeenCalled(); expect(container.querySelector("button")).toBe(existing);
      fireEvent.click(within(container).getByRole("button", { name: "Check-in" }));
      await waitFor(() => expect(mocks.openWindow).toHaveBeenCalledWith("check-in", "showpilot-demo-nov04"));
    } finally { await act(async () => root?.unmount()); container.remove(); }
  });
  it.each([null, { mode: "empty", orgId: "org-1", commandSource: "cloud" }, { mode: "prepared", orgId: "org-1", commandSource: "cloud" }, { mode: "finished", orgId: "org-1", commandSource: "cloud" }, { mode: "active", orgId: "another-org", commandSource: "local" }])("shows no local UI when this workspace is not running on this computer: %j", async state => {
    mocks.localStatus = state; render(<DesktopStatusBar orgId="org-1" />); await act(async () => {});
    expect(screen.queryByText(/Local show|Local engine|Venue Bridge mode|Use this computer|Off|Unreachable/)).toBeNull();
    expect(screen.queryByLabelText("Running on this computer")).toBeNull(); expect(mocks.getBridgeStatus).not.toHaveBeenCalled(); expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("shows exactly one quiet indicator for an active local show in the current workspace", async () => {
    mocks.localStatus = { mode: "active", orgId: "org-1", commandSource: "local" }; render(<DesktopStatusBar orgId="org-1" />);
    expect(await screen.findByLabelText("Running on this computer")).toBeTruthy(); expect(screen.getAllByText("On this computer")).toHaveLength(1);
  });
  it("shows one plain window failure while keeping other controls usable", async () => {
    mocks.openWindow.mockRejectedValueOnce(Error("IPC window permission denied")); render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check-in" })); expect((await screen.findByRole("alert")).textContent).toContain("This window could not open.");
    expect(screen.getByRole("alert").textContent).not.toContain("IPC"); expect(screen.getByRole("button", { name: "Check-in" }).hasAttribute("disabled")).toBe(false);
  });
  it("does not duplicate a slow window invocation after its display deadline", async () => {
    vi.useFakeTimers(); let finish!: () => void; mocks.openWindow.mockReturnValue(new Promise<void>(done => { finish = done; })); render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check-in" })); await act(() => vi.advanceTimersByTimeAsync(12000));
    expect(screen.getAllByRole("alert")).toHaveLength(1); const button = screen.getByRole("button", { name: "Check-in" }); expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button); expect(mocks.openWindow).toHaveBeenCalledTimes(1);
    await act(async () => finish()); expect(screen.queryByRole("alert")).toBeNull(); expect(button.hasAttribute("disabled")).toBe(false);
  });
  it("keeps update failure retryable with one plain message", async () => {
    mocks.checkUpdate.mockResolvedValue({ version: "0.2.0", notes: null, date: null }); mocks.installUpdate.mockRejectedValueOnce(Error("Could not write the application bundle")); render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" })); fireEvent.click(await screen.findByRole("button", { name: "Update 0.2.0" })); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install and restart" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The update could not finish."); expect(screen.getByRole("button", { name: "Update 0.2.0" }).hasAttribute("disabled")).toBe(false);
  });
  it("retains a slow installation across remounts and accepts its late receipt without installing twice", async () => {
    vi.useFakeTimers(); mocks.checkUpdate.mockResolvedValue({ version: "0.2.0", notes: null, date: null }); let finish!: (v: { version: string; restartRequired: boolean }) => void;
    mocks.installUpdate.mockReturnValue(new Promise(resolve => { finish = resolve; })); const view = render(<DesktopStatusBar />);
    fireEvent.click(screen.getByRole("button", { name: "Check update" })); await act(() => vi.advanceTimersByTimeAsync(0)); fireEvent.click(screen.getByRole("button", { name: "Update 0.2.0" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install and restart" })); await act(() => vi.advanceTimersByTimeAsync(60000));
    view.unmount(); render(<DesktopStatusBar />); const button = screen.getByRole("button", { name: "Update 0.2.0" }); expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button); expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
    await act(async () => finish({ version: "0.2.0", restartRequired: true })); expect(screen.getByRole("button", { name: "Restart required" }).hasAttribute("disabled")).toBe(true); expect(screen.queryByRole("alert")).toBeNull();
  });
  it("moves updates into an accessible compact menu and preserves keyboard focus", async () => {
    const observers = new Map<Element, ResizeObserverCallback>(); vi.stubGlobal("ResizeObserver", class { constructor(private callback: ResizeObserverCallback) {} observe(el: Element) { observers.set(el, this.callback); } disconnect() {} });
    render(<DesktopStatusBar />); const region = screen.getByRole("region", { name: "Desktop controls" });
    act(() => observers.get(region)!([{ target: region, contentRect: new DOMRect(0, 0, 860, 44), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver));
    fireEvent.click(screen.getByRole("button", { name: "Desktop actions" })); const menu = screen.getByRole("dialog", { name: "Desktop actions" });
    expect(within(menu).getByRole("button", { name: "Check update" })).toBeTruthy(); expect(within(menu).queryByRole("button", { name: "Local show" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check-in" }).closest('[role="dialog"]')).toBeNull(); fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Desktop actions" })).toBeNull()); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Desktop actions" }));
  });
});
describe("local choice is in Settings", () => {
  it("never claims on mount and requires the original explicit setup choice", async () => {
    render(setup()); fireEvent.click(await screen.findByRole("button", { name: "Use this computer" })); expect(mocks.configure).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Use this computer" })); await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(1)); expect(mocks.configure).toHaveBeenCalledWith("showpilot-demo-nov04", true, expect.any(Function));
  });
  it("does not apply a confirmation belonging to an earlier workspace", async () => {
    const view = render(setup()); fireEvent.click(await screen.findByRole("button", { name: "Use this computer" })); const dialog = screen.getByRole("dialog"); mocks.slug = "other-fixture"; view.rerender(setup());
    fireEvent.click(within(dialog).getByRole("button", { name: "Use this computer" })); await act(async () => {}); expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("opens the saved workspace only from Settings and surfaces a plain failure", async () => {
    mocks.openLocalShow.mockRejectedValueOnce(Error("Unsupported native command")); render(setup()); fireEvent.click(screen.getByRole("button", { name: "Open saved show" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This computer could not be set up."); expect(mocks.openLocalShow).toHaveBeenCalledTimes(1);
  });
});
