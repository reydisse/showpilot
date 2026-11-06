import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoadRundownModal } from "./LoadRundownModal";
import { listRundownDates, listSavedRundowns, getRundownState, loadSavedRundown } from "@/lib/rundown";
vi.mock("@/lib/rundown", () => ({ listRundownDates: vi.fn(), listSavedRundowns: vi.fn(), getRundownState: vi.fn(), loadSavedRundown: vi.fn(), deleteSavedRundown: vi.fn() }));
const props = () => ({ orgId: "fixture-org", currentItemCount: 0, playing: false, revision: 1, onLoad: vi.fn(), onClose: vi.fn() });
const rundown = { items: [], timer: { playback: "stop" as const, currentItemId: null, elapsed: 0, startedAt: null, pausedAt: null, mode: "count-down" as const, serverTime: 1 }, meta: { name: "Earlier show", serviceDate: "2026-11-01", status: "stopped" as const } };
beforeEach(() => {
  vi.mocked(listRundownDates).mockResolvedValue([{ showId: "source-show", date: "2026-11-01", name: "Earlier show", scheduledStartTime: null, itemCount: 0 }]);
  vi.mocked(listSavedRundowns).mockResolvedValue([{ id: "template", name: "Sunday template", itemCount: 0, createdAt: "2026-11-01", updatedAt: "2026-11-01" }]);
  vi.mocked(getRundownState).mockResolvedValue(rundown);
  vi.mocked(loadSavedRundown).mockResolvedValue({ id: "template", name: "Sunday template", serviceName: "Saved show", scheduledStartTime: "09:00", items: [], createdAt: "2026-11-01", updatedAt: "2026-11-01" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const selectDate = async () => fireEvent.click(await screen.findByRole("button", { name: /Earlier show/ }));

it("shows a timestamped list error, never an empty state, and reloads on retry", async () => {
  vi.mocked(listRundownDates).mockRejectedValueOnce(new Error("offline"));
  render(<LoadRundownModal {...props()} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not load rundowns"));
  expect(screen.getByRole("alert").querySelector("time")?.dateTime).toBeTruthy();
  expect(screen.queryByText("No previous rundowns found")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry list" }));
  expect(await screen.findByRole("button", { name: /Earlier show/ })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves the selection after a failed read and retries without applying it twice", async () => {
  vi.mocked(getRundownState).mockRejectedValueOnce(new Error("offline"));
  const input = props(); render(<LoadRundownModal {...input} />); await selectDate();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not read"));
  expect(input.onLoad).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry load" }));
  await waitFor(() => expect(input.onLoad).toHaveBeenCalledTimes(1));
  expect(vi.mocked(getRundownState).mock.calls.map(([input]) => input?.data)).toEqual([
    { orgId: "fixture-org", serviceDate: "2026-11-01", showId: "source-show" }, { orgId: "fixture-org", serviceDate: "2026-11-01", showId: "source-show" },
  ]);
});

it("explains a template removed since listing instead of silently doing nothing", async () => {
  vi.mocked(loadSavedRundown).mockResolvedValue(null);
  const input = props(); render(<LoadRundownModal {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Saved Templates" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Sunday template/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("refresh the list"));
  expect(input.onLoad).not.toHaveBeenCalled();
});

it("bounds a hung read and ignores its result after timeout and successful retry", async () => {
  const input = props(); render(<LoadRundownModal {...input} />);
  await screen.findByRole("button", { name: /Earlier show/ });
  let finish: ((value: typeof rundown) => void) | undefined;
  vi.mocked(getRundownState).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: /Earlier show/ }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry load" }));
  await act(async () => { await Promise.resolve(); });
  expect(input.onLoad).toHaveBeenCalledTimes(1);
  await act(async () => finish?.(rundown));
  expect(input.onLoad).toHaveBeenCalledTimes(1);
});

it("bounds list loading and ignores the old response after a retry", async () => {
  let finish: ((value: Awaited<ReturnType<typeof listRundownDates>>) => void) | undefined;
  vi.mocked(listRundownDates).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.useFakeTimers(); render(<LoadRundownModal {...props()} />);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry list" }));
  await act(async () => { await Promise.resolve(); });
  await act(async () => finish?.([]));
  expect(screen.getByRole("button", { name: /Earlier show/ })).toBeTruthy();
});

it("discards a late read when the organization changes", async () => {
  let finish: ((value: typeof rundown) => void) | undefined;
  vi.mocked(getRundownState).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = props(); const view = render(<LoadRundownModal {...input} />); await selectDate();
  view.rerender(<LoadRundownModal {...input} orgId="different-org" />);
  await act(async () => finish?.(rundown));
  expect(input.onLoad).not.toHaveBeenCalled();
});

it("requires replacement confirmation and rejects a stale revision or a newly running timer", async () => {
  const input = { ...props(), currentItemCount: 3 }; const view = render(<LoadRundownModal {...input} />); await selectDate();
  const confirm = await screen.findByRole("dialog", { name: "Replace the current rundown?" });
  expect(input.onLoad).not.toHaveBeenCalled();
  view.rerender(<LoadRundownModal {...input} playing />);
  expect(within(confirm).getByRole("button", { name: "Replace rundown" })).toHaveProperty("disabled", true);
  view.rerender(<LoadRundownModal {...input} revision={2} />);
  expect(within(confirm).getByRole("button", { name: "Replace rundown" })).toHaveProperty("disabled", true);
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await selectDate();
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Replace the current rundown?" })).getByRole("button", { name: "Replace rundown" }));
  await waitFor(() => expect(input.onLoad).toHaveBeenCalledTimes(1));
});

it("shows an uncertain apply failure without offering an unsafe duplicate retry", async () => {
  const input = props(); input.onLoad.mockRejectedValueOnce(new Error("write failed"));
  render(<LoadRundownModal {...input} />); await selectDate();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not confirm"));
  expect(screen.queryByRole("button", { name: "Retry load" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh list" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: /Earlier show/ })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Review current rundown" }));
  expect(input.onClose).toHaveBeenCalledTimes(1);
});

it("ignores a selected read after the dialog unmounts", async () => {
  let finish: ((value: typeof rundown) => void) | undefined;
  vi.mocked(getRundownState).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = props(); const view = render(<LoadRundownModal {...input} />); await selectDate();
  view.unmount(); await act(async () => finish?.(rundown));
  expect(input.onLoad).not.toHaveBeenCalled();
});

it("bounds an unconfirmed apply without issuing another write", async () => {
  const input = props(); input.onLoad.mockImplementation(() => new Promise(() => {}));
  render(<LoadRundownModal {...input} />); await screen.findByRole("button", { name: /Earlier show/ });
  vi.useFakeTimers(); fireEvent.click(screen.getByRole("button", { name: /Earlier show/ }));
  await act(async () => { await Promise.resolve(); });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Review current rundown" })).toBeTruthy();
  expect(input.onLoad).toHaveBeenCalledTimes(1);
});
