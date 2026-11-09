import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformsWorkspace } from "@/routes/$slug/streaming/platforms";

const api = vi.hoisted(() => ({ read: vi.fn(), add: vi.fn(), update: vi.fn(), live: vi.fn(), stop: vi.fn(), remove: vi.fn(), toggle: vi.fn(), inputs: vi.fn(), statuses: vi.fn() }));
vi.mock("@/lib/stream-destinations", () => ({
  getStreamDestinations: api.read, addStreamDestination: api.add, updateStreamDestination: api.update,
  getOutputStatuses: api.statuses, deleteStreamDestination: api.remove, toggleStreamDestination: api.toggle,
  connectDestinationsToInput: api.live, disconnectAllDestinations: api.stop,
}));
vi.mock("@/lib/stream", () => ({ getLiveInputs: api.inputs }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}), useRouter: () => ({ invalidate: vi.fn() }), useBlocker: () => ({ status: "idle" }),
}));
const row = { id: "fixture-destination", orgId: "fixture", name: "Fixture stream", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", outputVersion: "", hasStreamKey: true, enabled: false, cfOutputId: "", liveInputId: "", createdAt: new Date() };
const initial = { orgId: "fixture", destinations: [row], inputs: [] };
beforeEach(() => { api.read.mockResolvedValue([row]); api.inputs.mockResolvedValue([]); api.statuses.mockResolvedValue({}); });
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


const input = { setupState: "ready" as const, id:"fixture-input",orgId:"fixture",name:"Fixture ingest",cfInputId:"provider-input",cfInputUid:"",rtmpUrl:"",srtUrl:"",status:"idle",hasRtmpKey:true,createdAt:new Date() };
const selected = {...row,enabled:true};
async function renderOutputs() {
  api.read.mockResolvedValue([selected]);api.inputs.mockResolvedValue([input]);
  render(<PlatformsWorkspace initial={{...initial,destinations:[selected],inputs:[input]}} />);await settle();
}
async function confirmOutput(label:string) {
  fireEvent.click(within(screen.getAllByRole("dialog").at(-1)!).getByRole("button",{name:label}));await settle();
}

it("confirms the named destinations and retries an exact Go Live request after a lost reply", async () => {
  vi.useFakeTimers();api.live.mockReturnValueOnce(new Promise(()=>{})).mockResolvedValueOnce([{id:row.id,success:true}]);
  await renderOutputs();fireEvent.click(screen.getByRole("button",{name:"Go Live"}));await settle();
  expect(screen.getByRole("dialog").textContent).toContain("Fixture ingest will forward to Fixture stream");
  expect(api.live).not.toHaveBeenCalled();await confirmOutput("Go Live");
  const sent=api.live.mock.calls[0][0].data;
  expect(sent).toMatchObject({orgId:"fixture",liveInputId:input.id,requestId:expect.any(String),targets:[{id:row.id,version:""}]});
  await act(()=>vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert",{name:"Output change"}).textContent).toContain("was not confirmed");
  fireEvent.click(screen.getByRole("button",{name:"Retry change"}));await settle();
  expect(api.live.mock.calls[1][0].data).toEqual(sent);
});

it("lets confirmed Disconnect all destinations supersede a held Go Live and ignores its later reply", async () => {
  let resolve!: (value:unknown)=>void;api.live.mockReturnValue(new Promise(done=>{resolve=done;}));
  api.stop.mockResolvedValue([{id:row.id,success:true}]);
  await renderOutputs();fireEvent.click(screen.getByRole("button",{name:"Go Live"}));await confirmOutput("Go Live");
  expect(screen.getByRole("button",{name:"Disconnect all destinations"}).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Disconnect all destinations"}));await settle();expect(api.stop).not.toHaveBeenCalled();
  await confirmOutput("Disconnect all destinations");
  expect(api.live.mock.calls[0][0].signal.aborted).toBe(true);
  expect(api.stop.mock.calls[0][0].data).toMatchObject({orgId:"fixture",targets:[{id:row.id,version:""}]});
  const reads=api.read.mock.calls.length;await act(async()=>resolve([{id:row.id,success:true}]));
  expect(api.read).toHaveBeenCalledTimes(reads);expect(screen.queryByRole("alert",{name:"Output change"})).toBeNull();
});

it("keeps partial Disconnect all destinations results retryable and retains the original target set", async () => {
  api.stop.mockResolvedValueOnce([{id:row.id,success:false,error:"Provider outcome unconfirmed"}]).mockResolvedValueOnce([{id:row.id,success:true}]);
  await renderOutputs();fireEvent.click(screen.getByRole("button",{name:"Disconnect all destinations"}));await confirmOutput("Disconnect all destinations");
  expect(screen.getByRole("alert",{name:"Output change"}).textContent).toContain("Fixture stream: Provider outcome unconfirmed");
  const sent=api.stop.mock.calls[0][0].data;
  fireEvent.click(screen.getByRole("button",{name:"Retry change"}));await settle();expect(api.stop.mock.calls[1][0].data).toEqual(sent);
});

it("retries only refresh after acknowledged output changes", async () => {
  vi.useFakeTimers();api.live.mockResolvedValue([{id:row.id,success:true}]);await renderOutputs();
  fireEvent.click(screen.getByRole("button",{name:"Go Live"}));await settle();
  api.read.mockReturnValueOnce(new Promise(()=>{})).mockResolvedValueOnce([selected]);await confirmOutput("Go Live");
  await act(()=>vi.advanceTimersByTimeAsync(8_000));
  fireEvent.click(screen.getByRole("button",{name:"Retry refresh"}));await settle();expect(api.live).toHaveBeenCalledTimes(1);
});

it("requires confirmation before deleting and retains the deletion request through a lost reply", async () => {
  vi.useFakeTimers();api.remove.mockReturnValueOnce(new Promise(()=>{})).mockResolvedValueOnce(undefined);await renderOutputs();
  fireEvent.click(screen.getByRole("button",{name:"Delete Fixture stream"}));await settle();expect(api.remove).not.toHaveBeenCalled();
  await confirmOutput("Cancel");await act(()=>vi.advanceTimersByTimeAsync(300));expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Delete Fixture stream"}));await confirmOutput("Delete destination");
  await act(()=>vi.advanceTimersByTimeAsync(10_000));const sent=api.remove.mock.calls[0][0].data;
  api.read.mockResolvedValue([]);fireEvent.click(screen.getByRole("button",{name:"Retry change"}));await settle();
  expect(api.remove.mock.calls[1][0].data).toEqual(sent);expect(screen.getByText("No streaming destinations")).toBeTruthy();
});

it("confirms disabling a configured output but selection alone never calls Go Live", async () => {
  api.toggle.mockResolvedValue(row);api.read.mockResolvedValue([{...selected,cfOutputId:"provider-output",liveInputId:input.id}]);api.inputs.mockResolvedValue([input]);
  render(<PlatformsWorkspace initial={{...initial,destinations:[{...selected,cfOutputId:"provider-output",liveInputId:input.id}],inputs:[input]}} />);await settle();
  fireEvent.click(screen.getByRole("button",{name:"Disable Fixture stream"}));await settle();expect(api.toggle).not.toHaveBeenCalled();
  api.read.mockResolvedValue([row]);await confirmOutput("Disable destination");expect(api.toggle.mock.calls[0][0].data.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Enable Fixture stream"}));await settle();expect(api.toggle.mock.calls[1][0].data.enabled).toBe(true);
  expect(api.live).not.toHaveBeenCalled();
});
