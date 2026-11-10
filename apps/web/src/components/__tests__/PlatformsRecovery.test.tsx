import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformsWorkspace } from "@/routes/$slug/streaming/platforms";

const api = vi.hoisted(() => ({ read: vi.fn(), add: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/stream-destinations", () => ({
  getStreamDestinations: api.read, addStreamDestination: api.add, updateStreamDestination: api.update,
  getOutputStatuses: vi.fn(), deleteStreamDestination: vi.fn(), toggleStreamDestination: vi.fn(),
  connectDestinationsToInput: vi.fn(), disconnectAllDestinations: vi.fn(),
}));
vi.mock("@/lib/stream", () => ({ getLiveInputs: async () => [] }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}), useRouter: () => ({ invalidate: vi.fn() }), useBlocker: () => ({ status: "idle" }),
}));
const row = { id: "fixture-destination", orgId: "fixture", name: "Fixture stream", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", hasStreamKey: true, enabled: false, cfOutputId: "", liveInputId: "", createdAt: new Date() };
const initial = { orgId: "fixture", destinations: [row], inputs: [] };
beforeEach(() => { api.read.mockResolvedValue([row]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const settle = () => act(async () => {});
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }

it("retains the exact create request and credential draft across a lost reply and editor reopening", async () => {
  vi.useFakeTimers();
  api.add.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(row);
  render(<PlatformsWorkspace initial={initial} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "Add Destination" }));
  change("Display Name", "New stream"); change("Stream key", "fixture-secret");
  fireEvent.click(screen.getByRole("button", { name: "Add destination" })); await settle();
  const sent = api.add.mock.calls[0][0].data;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert", { name: "Destination change" }).textContent).toContain("was not confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Close destination editor" }));
  await act(() => vi.advanceTimersByTimeAsync(300));
  fireEvent.click(screen.getByRole("button", { name: "Review destination draft" }));
  expect(screen.getByLabelText("Display Name").getAttribute("value")).toBe("New stream");
  expect(screen.getByLabelText("Stream key").getAttribute("value")).toBe("fixture-secret");
  fireEvent.click(screen.getByRole("button", { name: "Retry change" })); await settle();
  expect(api.add).toHaveBeenCalledTimes(2);
  expect(api.add.mock.calls[1][0].data).toEqual(sent);
  expect(sent).toMatchObject({ orgId: "fixture", requestId: expect.any(String), name: "New stream", streamKey: "fixture-secret" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retries only the list read after a save is acknowledged and retains a blank existing key", async () => {
  vi.useFakeTimers();
  api.update.mockResolvedValue(row);
  render(<PlatformsWorkspace initial={initial} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "Edit Fixture stream" }));
  change("Display Name", "Edited stream");
  api.read.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce([{ ...row, name: "Edited stream" }]);
  fireEvent.click(screen.getByRole("button", { name: "Update destination" })); await settle();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.getByRole("alert", { name: "Destination change" }).textContent).toContain("Change saved.");
  fireEvent.click(screen.getByRole("button", { name: "Retry refresh" })); await settle();
  expect(api.update).toHaveBeenCalledTimes(1);
  expect(api.update.mock.calls[0][0].data).toMatchObject({ orgId: "fixture", id: row.id, updates: { name: "Edited stream", streamKey: "" } });
  expect(screen.getByText("Edited stream")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("bounds configuration reads without hiding confirmed destinations or flashing an empty state", async () => {
  vi.useFakeTimers(); api.read.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce([]);
  render(<PlatformsWorkspace initial={initial} />); await settle();
  expect(screen.getByText("Fixture stream")).toBeTruthy();
  expect(screen.queryByText("No streaming destinations")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.getByRole("button", { name: "Edit Fixture stream" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry destinations" })); await settle();
  expect(screen.getByText("No streaming destinations")).toBeTruthy();
});

it("ignores a late save from a previous organization", async () => {
  let complete: (value: typeof row) => void = () => {};
  api.add.mockReturnValue(new Promise<typeof row>(resolve => { complete = resolve; }));
  const view = render(<PlatformsWorkspace key="fixture" initial={initial} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "Add Destination" }));
  change("Display Name", "Old workspace draft"); change("Stream key", "fixture-key");
  fireEvent.click(screen.getByRole("button", { name: "Add destination" })); await settle();
  api.read.mockResolvedValue([]);
  view.rerender(<PlatformsWorkspace key="other" initial={{ orgId: "other", destinations: [], inputs: [] }} />); await settle();
  const reads = api.read.mock.calls.length;
  await act(async () => complete(row));
  expect(api.add.mock.calls[0][0].signal.aborted).toBe(true);
  expect(api.read).toHaveBeenCalledTimes(reads);
  expect(screen.queryByText("Fixture stream")).toBeNull();
  expect(screen.getByText("No streaming destinations")).toBeTruthy();
});
