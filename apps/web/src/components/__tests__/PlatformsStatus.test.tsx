import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/$slug/streaming/platforms";

const api = vi.hoisted(() => {
  const initial: Record<string, unknown> = {};
  return { statuses: vi.fn(), invalidate: vi.fn(), initial };
});
vi.mock("@/lib/stream-destinations", () => ({
  getOutputStatuses: api.statuses, getStreamDestinations: async () => api.initial.destinations, addStreamDestination: vi.fn(),
  updateStreamDestination: vi.fn(), deleteStreamDestination: vi.fn(), toggleStreamDestination: vi.fn(),
  connectDestinationsToInput: vi.fn(), disconnectAllDestinations: vi.fn(),
}));
vi.mock("@/lib/stream", () => ({ getLiveInputs: async () => api.initial.inputs }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ options, useLoaderData: () => api.initial }),
  useRouter: () => ({ invalidate: api.invalidate }),
  useBlocker: () => ({ status: "idle" }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
const Page = Route.options.component as React.ComponentType;
const destination = { id: "destination-a", orgId: "fixture", name: "Fixture output", platform: "youtube", rtmpUrl: "rtmp://example.test/fixture", hasStreamKey: true, enabled: true, cfOutputId: "provider-a", liveInputId: "input-a", createdAt: new Date() };
const initial = { orgId: "fixture", destinations: [destination], inputs: [{ id: "input-a", name: "Fixture ingest" }] };

it("does not label an enabled provider output as perpetually Connecting", async () => {
  api.initial = initial;
  api.statuses.mockResolvedValue({ [destination.id]: { status: "enabled" } });
  render(<Page />);
  await act(async () => {});
  expect(screen.queryByText(/Connecting to 1 platform/)).toBeNull();
  expect(screen.getByText(/1 output enabled/)).toBeTruthy();
});

it("bounds a stalled status poll and exposes Retry without output mutations", async () => {
  vi.useFakeTimers();
  api.initial = initial;
  api.statuses.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ [destination.id]: { status: "disabled" } });
  render(<Page />);
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  fireEvent.click(screen.getByRole("button", { name: "Retry output status" }));
  await act(async () => {});
  expect(screen.getByText(/Output disabled/)).toBeTruthy();
  expect(api.statuses).toHaveBeenCalledTimes(2);
  expect(api.invalidate).not.toHaveBeenCalled();
});

it("discards a late previous-workspace status without labelling the new output enabled", async () => {
  let complete: (value: unknown) => void = () => {};
  api.initial = initial;
  api.statuses.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }))
    .mockResolvedValueOnce({ "other-output": { status: "disabled" } });
  const view = render(<Page />);
  await act(async () => {});
  api.initial = { ...initial, orgId: "other", destinations: [{ ...destination, id: "other-output", orgId: "other", name: "Other output" }] };
  view.rerender(<Page />);
  await act(async () => {});
  expect(screen.getByText("Output disabled")).toBeTruthy();
  expect(api.statuses.mock.calls.at(-1)?.[0].data.orgId).toBe("other");
  await act(async () => complete({ [destination.id]: { status: "enabled" } }));
  expect(screen.getByText("0 outputs enabled")).toBeTruthy();
  expect(screen.getByText("Output disabled")).toBeTruthy();
});

it("refreshes when the bound provider output changes even if the destination count stays the same", async () => {
  api.initial = initial;
  api.statuses.mockResolvedValueOnce({ [destination.id]: { status: "disabled" } })
    .mockResolvedValueOnce({ [destination.id]: { status: "enabled" } });
  const view = render(<Page />);
  await act(async () => {});
  expect(screen.getByText("Output disabled")).toBeTruthy();
  api.initial = { ...initial, destinations: [{ ...destination, cfOutputId: "replacement-output" }] };
  view.rerender(<Page />);
  await act(async () => {});
  expect(api.statuses).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Output enabled")).toBeTruthy();
});

it("coalesces visible polls, pauses when hidden and ignores the abandoned reply after returning", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  let complete: (value: unknown) => void = () => {};
  api.initial = initial;
  api.statuses.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }))
    .mockResolvedValueOnce({ [destination.id]: { status: "disabled" } });
  render(<Page />);
  await act(async () => {});
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(api.statuses).toHaveBeenCalledTimes(1);
  visibility = "hidden";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(api.statuses.mock.calls[0]?.[0].signal.aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.statuses).toHaveBeenCalledTimes(1);
  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(api.statuses).toHaveBeenCalledTimes(2);
  await act(async () => complete({ [destination.id]: { status: "enabled" } }));
  expect(screen.getByText("Output disabled")).toBeTruthy();
  expect(screen.getByText("0 outputs enabled")).toBeTruthy();
});
