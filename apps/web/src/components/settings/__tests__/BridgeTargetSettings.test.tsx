import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ list: vi.fn(), approve: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/bridge-target-settings", () => ({ getBridgeTargetPolicy: api.list, approveBridgeDestination: api.approve, removeBridgeDestination: api.remove }));
import { BridgeTargetSettings } from "../BridgeTargetSettings";
const target = { id: "target", label: "Venue OBS", host: "venue.local", port: 4455, protocol: "obs", approvedByUserId: "admin", approvedAt: 1 };
beforeEach(() => { vi.resetAllMocks(); api.list.mockResolvedValue([target]); api.approve.mockResolvedValue([target]); api.remove.mockResolvedValue([]); });
afterEach(cleanup);

it("shows approved endpoint identity and requires explicit removal confirmation", async () => {
  render(<BridgeTargetSettings orgId="org-1" />);
  await screen.findByText("venue.local:4455 · OBS");
  fireEvent.click(screen.getByRole("button", { name: "Remove approval for Venue OBS" }));
  expect(screen.getByRole("dialog").textContent).toContain("Remove approval for Venue OBS?");
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove approval for Venue OBS" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove approval" }));
  await screen.findByText("No Bridge destinations approved yet.");
  expect(api.remove).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", id: "target", confirmed: true } });
});
it("preserves an entered destination and reports a failed approval", async () => {
  api.approve.mockRejectedValue(new Error("Approval could not be saved"));
  render(<BridgeTargetSettings orgId="org-1" />);
  await screen.findByText("Venue OBS");
  fireEvent.change(screen.getByLabelText("Destination name"), { target: { value: "ProPresenter" } });
  fireEvent.change(screen.getByLabelText("Host or IP address"), { target: { value: "192.168.1.10" } });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "50001" } });
  fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "propresenter" } });
  expect(screen.getByText(/Approve each configured port/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve destination" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Approval could not be saved");
  expect(api.approve).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", label: "ProPresenter", host: "192.168.1.10", port: "50001", protocol: "propresenter" } });
  expect((screen.getByLabelText("Destination name") as HTMLInputElement).value).toBe("ProPresenter");
});
it("discards an old workspace's late policy after switching away and back", async () => {
  let resolve: (value: typeof target[]) => void = () => {};
  api.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<BridgeTargetSettings orgId="org-1" />);
  view.rerender(<BridgeTargetSettings orgId="org-2" />);
  await screen.findByText("Venue OBS");
  view.rerender(<BridgeTargetSettings orgId="org-1" />);
  await screen.findByText("Venue OBS");
  await act(async () => resolve([{ ...target, label: "Stale destination" }]));
  expect(screen.queryByText("Stale destination")).toBeNull();
});
