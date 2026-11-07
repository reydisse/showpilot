import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DevicesWorkspace } from "@/routes/$slug/dashboard/devices.index";

const api = vi.hoisted(() => ({ read: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/data", () => ({ getDevices: api.read, addDevice: vi.fn(), updateDevice: vi.fn(), deleteDevice: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({ useSearch: () => ({}), useNavigate: () => api.navigate }),
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/hooks/useDeviceModule", () => ({ useDeviceModule: () => ({ module: null, status: "disconnected", feedbacks: new Map(), definition: undefined, bridgeOnline: false, error: null, errorAt: null }) }));
vi.mock("@/components/devices/DeviceControlPanel", () => ({ DeviceControlPanel: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

const row = { id: "first-device", orgId: "fixture", name: "Stage mixer", category: "mixer", adapterType: "fixture-mixer", settings: "{}", enabled: false, latencyMs: 0, createdAt: new Date(), updatedAt: new Date() };
const second = { ...row, id: "second-device", name: "Screen output", category: "video", adapterType: "fixture-screen" };

it("bounds a stalled device read and retains confirmed devices until Retry", async () => {
  vi.useFakeTimers();
  api.read.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce([]);
  render(<DevicesWorkspace devices={[row]} orgId="fixture" slug="fixture" />);
  await act(async () => {});
  expect(screen.getByRole("heading", { name: "Stage mixer" })).toBeTruthy();
  expect(screen.queryByText("No devices registered")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.queryByText(/Refreshing devices/)).toBeNull();
  expect(screen.getByRole("heading", { name: "Stage mixer" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit configuration" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry devices" }));
  await act(async () => {});
  expect(screen.getByText("No devices registered")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Stage mixer" })).toBeNull();
});

it("filters both mobile options and desktop selection without changing the selected device", async () => {
  api.read.mockResolvedValue([row, second]);
  render(<DevicesWorkspace devices={[row, second]} orgId="fixture" slug="fixture" />);
  await act(async () => {});
  fireEvent.change(screen.getByRole("textbox", { name: "Search devices" }), { target: { value: "screen" } });
  const selector = screen.getByRole("combobox", { name: "Control device" });
  expect(within(selector).getAllByRole("option").map(option => option.textContent)).toEqual(["Choose a matching device", "Screen output"]);
  expect(screen.queryByRole("button", { name: "Select Stage mixer" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Stage mixer" })).toBeTruthy();
  expect(api.navigate).not.toHaveBeenCalled();
  fireEvent.change(selector, { target: { value: second.id } });
  expect(api.navigate).toHaveBeenCalledWith({ search: { device: second.id }, replace: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Search devices" }), { target: { value: "missing" } });
  expect(selector.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(within(selector).getAllByRole("option")).toHaveLength(3);
});

it("rejects a late previous-workspace response after changing organizations", async () => {
  let complete: (value: typeof row[]) => void = () => {};
  api.read.mockReturnValueOnce(new Promise<typeof row[]>(resolve => { complete = resolve; })).mockResolvedValueOnce([]);
  const view = render(<DevicesWorkspace key="fixture" devices={[row]} orgId="fixture" slug="fixture" />);
  await act(async () => {});
  view.rerender(<DevicesWorkspace key="other" devices={[]} orgId="other" slug="other" />);
  await act(async () => {});
  expect(api.read.mock.calls.at(-1)?.[0].data.orgId).toBe("other");
  await act(async () => complete([row]));
  expect(screen.queryByRole("heading", { name: "Stage mixer" })).toBeNull();
  expect(screen.getByText("No devices registered")).toBeTruthy();
});
