import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShowReportExport } from "../ShowReportExport";
const rpc = vi.hoisted(() => ({ list: vi.fn(), report: vi.fn(), file: vi.fn() }));
vi.mock("@/lib/rundown", () => ({ listRundownDates: rpc.list }));
vi.mock("@/lib/report", () => ({ exportShowReport: rpc.report }));
vi.mock("@/lib/settings-report-file", () => ({ createSettingsReportFile: rpc.file }));
const shows = [
  { showId: "morning", date: "2026-11-07", name: "Morning", scheduledStartTime: null, itemCount: 2 },
  { showId: "evening", date: "2026-11-07", name: "Evening", scheduledStartTime: null, itemCount: 3 },
];
const createURL = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  rpc.list.mockReset().mockResolvedValue(shows);
  rpc.report.mockReset().mockResolvedValue({});
  rpc.file.mockReset().mockResolvedValue(new Blob(["report"]));
  createURL.mockReset().mockReturnValue("blob:fixture");
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: createURL, revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Export show data" }));
  await settle();
}
const view = () => render(<ShowReportExport orgId="org" slug="test" />);

it("bounds the show-list read and retries without presenting an empty state", async () => {
  rpc.list.mockImplementationOnce(() => new Promise(() => {}));
  view(); await open();
  expect(screen.getByText("Loading available shows…")).toBeTruthy();
  await settle(8_100);
  expect(screen.queryByText("Loading available shows…")).toBeNull();
  expect(screen.queryByText(/No saved shows/)).toBeNull();
  expect(rpc.list.mock.calls[0][0].signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry loading shows" }));
  await settle();
  expect(screen.getByRole("combobox", { name: "Show and date" })).toBeTruthy();
  expect(rpc.report).not.toHaveBeenCalled();
});
it("reports an empty list only after a successful read", async () => {
  rpc.list.mockResolvedValue([]);
  view(); await open();
  expect(screen.getByText(/No saved shows/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(true);
});
it("retains the selected same-date show, format and sections on failed export retry", async () => {
  rpc.report.mockRejectedValueOnce(new Error("offline"));
  view(); await open();
  fireEvent.change(screen.getByRole("combobox", { name: "Show and date" }), { target: { value: "evening" } });
  fireEvent.click(screen.getByRole("radio", { name: "CSV" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Crew" }));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await settle();
  expect(screen.getByRole("alert").textContent).toContain("Your selections are kept");
  fireEvent.click(screen.getByRole("button", { name: "Retry download" }));
  await settle();
  expect(rpc.report.mock.calls.map(([args]) => args.data)).toEqual([
    { orgId: "org", serviceDate: "2026-11-07", showId: "evening" },
    { orgId: "org", serviceDate: "2026-11-07", showId: "evening" },
  ]);
  expect(rpc.file.mock.calls[0][0].format).toBe("csv");
  expect(rpc.file.mock.calls[0][0].sections).not.toContain("crew");
  expect(createURL).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain("test-show-report-2026-11-07-evening.csv");
});
it("times out a reply and ignores it after a successful retry", async () => {
  let release = (_: unknown) => {};
  rpc.report.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  view(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await settle(10_100);
  expect(rpc.report.mock.calls[0][0].signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry download" }));
  await settle();
  release({}); await settle();
  expect(createURL).toHaveBeenCalledOnce();
  expect(rpc.file).toHaveBeenCalledOnce();
});
it("also bounds file encoding and ignores its late completion", async () => {
  let release = (_: Blob) => {};
  rpc.file.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  view(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await settle(10_100);
  expect(screen.getByRole("button", { name: "Retry download" })).toBeTruthy();
  release(new Blob(["late"])); await settle();
  expect(createURL).not.toHaveBeenCalled();
});
it.each(["close", "unmount"])("cancels download on %s and does not act on a late reply", async mode => {
  let release = (_: unknown) => {};
  rpc.report.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const mounted = view(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  if (mode === "close") fireEvent.click(screen.getByRole("button", { name: "Close export dialog" }));
  else mounted.unmount();
  release({}); await settle();
  expect(rpc.report.mock.calls[0][0].signal.aborted).toBe(true);
  expect(createURL).not.toHaveBeenCalled();
});
it("requires a new choice when the selected show disappears instead of exporting another show", async () => {
  view(); await open();
  fireEvent.change(screen.getByRole("combobox", { name: "Show and date" }), { target: { value: "evening" } });
  fireEvent.click(screen.getByRole("button", { name: "Close export dialog" }));
  rpc.list.mockResolvedValueOnce([shows[0]]);
  await open();
  expect(screen.getByText(/previously selected show is no longer available/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(true);
  expect(rpc.report).not.toHaveBeenCalled();
});
