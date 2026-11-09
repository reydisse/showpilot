import { afterEach, expect, it, vi } from "vitest";
import { NativeMidiControllerRuntime } from "../native-midi-controller";

const ipc = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(), events: (_data: unknown) => {} }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class { set onmessage(callback: (data: unknown) => void) { ipc.events = callback; } },
}));
const port = { id: "native:1", name: "APC", manufacturer: null };
const opened: NativeMidiControllerRuntime[] = [];
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(async () => {
  opened.splice(0).forEach(runtime => runtime.stop());
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.resetAllMocks();
});
async function fixture() {
  vi.useFakeTimers();
  let status = { sessionId: "", revision: 0, generation: 0, inputs: [port], outputs: [port], inputConnected: false, outputConnected: false, error: null };
  ipc.invoke.mockImplementation(async (command, args) => {
    if (command === "midi_controller_open" && typeof args?.sessionId === "string") status.sessionId = args.sessionId;
    if (command === "midi_controller_select" && typeof args?.revision === "number") status = { ...status, revision: args.revision, generation: status.generation + 1, inputConnected: true, outputConnected: true };
    return { ...status };
  });
  const callbacks = { message: vi.fn(), ports: vi.fn(), error: vi.fn(), closed: vi.fn() };
  const runtime = await NativeMidiControllerRuntime.connect(callbacks); opened.push(runtime);
  runtime.select(port, port); await settle();
  ipc.invoke.mockClear(); callbacks.ports.mockClear();
  const message = (data: number[], changes = {}) => ipc.events({ type: "message", sessionId: status.sessionId, generation: status.generation, data, ...changes });
  return { runtime, callbacks, message, status: () => ({ ...status }) };
}

it("shares note edges and CC decoding, rejecting system traffic and stale session callbacks", async () => {
  const { message, runtime, callbacks } = await fixture();
  message([0x90, 4, 127]); message([0x90, 4, 127]); message([0x80, 4, 127]); message([0x90, 4, 127]);
  message([0xb2, 48, 13]); message([0xb2, 48, 13]); message([0xf2, 0, 0]);
  message([0x90, 5, 127], { generation: 0 }); message([0x90, 5, 127], { sessionId: "old-window" });
  expect(callbacks.message.mock.calls).toEqual([
    [{ kind: "note", channel: 0, number: 4 }, 127, undefined],
    [{ kind: "note", channel: 0, number: 4 }, 0, 127],
    [{ kind: "note", channel: 0, number: 4 }, 127, 0],
    [{ kind: "cc", channel: 2, number: 48 }, 13, undefined],
  ]);
  runtime.resetInput(); message([0x90, 4, 127]);
  expect(callbacks.message.mock.calls.at(-1)?.[2]).toBeUndefined();
  runtime.stop(); message([0x90, 8, 127]); expect(callbacks.message).toHaveBeenCalledTimes(5);
});

it("blocks old inputs throughout async selection and ignores reversed selection replies", async () => {
  const { runtime, status, callbacks, message } = await fixture();
  const replies: ((value: unknown) => void)[] = [];
  ipc.invoke.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  runtime.select({ ...port, id: "native:2" }, port);
  runtime.select({ ...port, id: "native:3" }, port);
  message([0x90, 4, 127]); expect(callbacks.message).not.toHaveBeenCalled();
  replies[1]({ ...status(), revision: 3, generation: 3 }); await settle();
  message([0x90, 4, 127], { generation: 3 }); expect(callbacks.message).toHaveBeenCalledOnce();
  replies[0]({ ...status(), revision: 2, generation: 2 }); await settle();
  message([0x90, 5, 127], { generation: 2 }); expect(callbacks.message).toHaveBeenCalledOnce();
  replies[2]({ ...status(), revision: 3, generation: 3 }); await settle();
});

it("coalesces fast LED updates to the latest desired state instead of queuing every clock tick", async () => {
  const { runtime, status } = await fixture();
  const replies: ((value: unknown) => void)[] = [];
  ipc.invoke.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  for (let value = 1; value <= 100; value++) runtime.feedback([[0x96, 4, value]]);
  expect(ipc.invoke).toHaveBeenCalledOnce();
  replies[0](status()); await settle();
  expect(ipc.invoke).toHaveBeenCalledTimes(2);
  expect(ipc.invoke.mock.calls[1][1]?.messages).toEqual([[0x96, 4, 100]]);
  replies[1](status()); await settle();
  runtime.feedback([[0x96, 4, 100]]); expect(ipc.invoke).toHaveBeenCalledTimes(2);
  runtime.feedback([]); replies[2](status()); await settle();
  expect(ipc.invoke.mock.calls[2][1]?.messages).toEqual([]);
});

it("polls without overlap and makes an expired native session reconnectable", async () => {
  const { runtime, callbacks, message } = await fixture();
  let rejectRefresh: (cause: unknown) => void = () => {};
  ipc.invoke.mockImplementation(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
  await vi.advanceTimersByTimeAsync(6_000);
  expect(ipc.invoke).toHaveBeenCalledOnce();
  rejectRefresh("MIDI session expired. Connect and arm the controller again."); await settle();
  expect(callbacks.closed).toHaveBeenCalledOnce(); expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining("expired"));
  message([0x90, 4, 127]); expect(callbacks.message).not.toHaveBeenCalled();
  expect(ipc.invoke.mock.calls.at(-1)?.[0]).toBe("midi_controller_close");
  runtime.stop(); expect(callbacks.closed).toHaveBeenCalledOnce();
});

it("times out an unresponsive engine and rejects malformed IPC before it can become a cue", async () => {
  const { callbacks } = await fixture();
  ipc.invoke.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(9_000);
  expect(callbacks.closed).toHaveBeenCalledOnce();
  expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining("did not respond"));
});

it("closes on malformed message bytes and drops all subsequent input", async () => {
  const { callbacks, message } = await fixture();
  message([0x90, -1, 127]); message([0x90, 4, 127]); await settle();
  expect(callbacks.closed).toHaveBeenCalledOnce(); expect(callbacks.message).not.toHaveBeenCalled();
});

it("refreshing unchanged ports does not discard pending fader movements", async () => {
  const { callbacks } = await fixture();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(callbacks.ports).not.toHaveBeenCalled();
});
