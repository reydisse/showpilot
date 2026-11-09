import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as shared from "@showpilot/shared";
import * as contract from "../../../../mobile/src/lib/timecode-contract.ts";

const sockets = [];
class Socket {
  readyState = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const appState = {
  currentState: "active", listener: null,
  addEventListener: (_event, listener) => {
    appState.listener = listener;
    return { remove() { appState.listener = null; } };
  },
};
const authenticate = vi.fn(async () => { const socket = new Socket(); sockets.push(socket); return socket; });
const modules = {
  react: React,
  "@showpilot/shared": shared,
  "react-native": { AppState: appState },
  "@/lib/auth-transport": { createAuthenticatedWebSocket: authenticate },
  "@/lib/env": { SHOWPILOT_URL: "https://native.test" },
  "@/lib/timecode-contract": contract,
};
const code = ts.transpileModule(readFileSync(resolve(process.cwd(), "../mobile/src/hooks/use-timecode-relay.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exported = {};
new Function("require", "exports", code)(name => {
  if (!(name in modules)) throw new Error(`Missing native module ${name}`);
  return modules[name];
}, exported);
const { useTimecodeRelay } = exported;
const target = { showId: "show", serviceDate: "2026-11-08" };
const state = (overrides = {}) => ({
  ...target, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
  display: "00:00:00:00", source: "internal-freerun", format: { frameRate: 25, dropFrame: "ndf" },
  running: false, serverTime: 1_000_000, totalFrames: 0, lyrics: null,
  triggersEnabled: true, signal: { status: "idle", lastFeedAt: null }, ...overrides,
});
const event = (overrides = {}) => ({
  id: "cue", label: "Next", triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 },
  triggerFrame: 250, action: "rundown-advance", payload: {}, fired: false, enabled: true,
  executionStatus: "scheduled", ...overrides,
});
function hydrate(socket, overrides = {}, control = "available") {
  socket.message({ type: "hydrate", ...target, state: state(overrides), events: [event()], control });
}
async function fixture(control = "available") {
  const f = renderHook(({ seed } = {}) => useTimecodeRelay("org", seed, target), { initialProps: {} });
  await act(async () => {});
  const socket = sockets[0];
  await act(async () => { socket.open(); hydrate(socket, {}, control); });
  return { ...f, socket };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal("WebSocket", { OPEN: 1, CONNECTING: 0 });
  sockets.length = 0; authenticate.mockClear(); appState.currentState = "active";
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("pins the websocket to the selected show", async () => {
  await fixture();
  expect(new URL(authenticate.mock.calls[0][0]).searchParams.get("showId")).toBe("show");
});
it("requires a full snapshot before Connected", async () => {
  const f = renderHook(() => useTimecodeRelay("org", undefined, target));
  await act(async () => {});
  await act(async () => sockets[0].open());
  expect(f.result.current.status).toBe("connecting");
  await act(async () => vi.advanceTimersByTimeAsync(12_001));
  expect(f.result.current.lastError).toMatch(/timed out/i);
  expect(sockets[0].readyState).toBe(3);
});
it("does not overwrite live state with a late HTTP poll", async () => {
  const f = await fixture();
  await act(async () => f.socket.message({ type: "tc-update", ...target, state: state({ display: "00:00:05:00", totalFrames: 125 }) }));
  f.rerender({ seed: { state: state(), events: [] } });
  expect(f.result.current.state.totalFrames).toBe(125);
});
it("preserves failed cue status instead of declaring it fired", async () => {
  const f = await fixture();
  await act(async () => f.socket.message({ type: "event-fired", ...target, event: event({ executionStatus: "failed", executionError: "Device unavailable" }) }));
  expect(f.result.current.events[0]).toMatchObject({ fired: false, executionStatus: "failed", executionError: "Device unavailable" });
});
it("reads current event actions without discarding the whole timeline", () => {
  expect(contract.parseMobileTimecodeEvents([event({ action: "timer-start" })])).not.toBeNull();
});
it("prevents another operator's clock from being started locally", async () => {
  const f = await fixture("other");
  await act(async () => f.result.current.startFreerun());
  expect(f.socket.sent.filter(message => message.action === "start")).toEqual([]);
  expect(f.result.current.lastError).toMatch(/another operator/i);
});
it("settles a rejected start and shows its reason", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  await act(async () => f.socket.message({ type: "command-rejected", ...target, action: "start", error: "The source is already running." }));
  expect(f.result.current.starting).toBe(false);
  expect(f.result.current.lastError).toContain("already running");
});
it("bounds a start whose grant never arrives", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(f.result.current.starting).toBe(false);
  expect(f.result.current.lastError).toMatch(/not confirmed|timed out/i);
  expect(f.result.current.status).not.toBe("connected");
});
it("retires an errored connection without waiting for close", async () => {
  const f = await fixture();
  f.socket.close = () => { f.socket.readyState = 2; };
  await act(async () => f.socket.onerror());
  expect(f.result.current.status).not.toBe("connected");
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(sockets.length).toBe(2);
});
it("does not restart an interrupted clock on reconnect", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  await act(async () => f.socket.message({ type: "master-status", ...target, granted: true }));
  await act(async () => f.socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = sockets.at(-1);
  await act(async () => { next.open(); hydrate(next); });
  expect(next.sent.filter(message => message.type === "command")).toEqual([]);
  expect(f.result.current.starting).toBe(false);
});
it("ignores late frames from a retired connection", async () => {
  const f = await fixture();
  await act(async () => f.socket.close());
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  const next = sockets.at(-1);
  await act(async () => { next.open(); hydrate(next, { totalFrames: 100 }); });
  await act(async () => hydrate(f.socket, { totalFrames: 999 }));
  expect(f.result.current.state.totalFrames).toBe(100);
});
it("rejects a snapshot for another show without replacing the last known clock", async () => {
  const f = await fixture();
  await act(async () => hydrate(f.socket, { showId: "other", totalFrames: 999 }));
  expect(f.result.current.state.totalFrames).toBe(0);
  expect(f.result.current.status).not.toBe("connected");
});

it("starts feeding only after the grant and reviewed running position both arrive", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  expect(f.socket.sent[0]).toMatchObject({ action: "start", payload: { startPosition: { expectedShowId: "show", expectedFrame: 0, expectedFormat: { frameRate: 25, dropFrame: "ndf" }, confirmed: true } } });
  await act(async () => f.socket.message({ type: "master-status", ...target, granted: true }));
  expect(f.socket.sent.some(item => item.action === "feed-tc")).toBe(false);
  await act(async () => f.socket.message({ type: "tc-update", ...target, state: state({ running: true }) }));
  expect(f.result.current.isMaster).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.socket.sent.at(-1)).toMatchObject({ action: "feed-tc", payload: { totalFrames: 25, timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } } });
});
it("does not feed from a different position than the one reviewed for Start", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  await act(async () => {
    f.socket.message({ type: "master-status", ...target, granted: true });
    f.socket.message({ type: "tc-update", ...target, state: state({ running: true, totalFrames: 300 }) });
  });
  expect(f.socket.sent.some(item => item.action === "feed-tc")).toBe(false);
  expect(f.result.current.lastError).toMatch(/reviewed start position/);
});
it("bounds a stop acknowledgement while retaining the last confirmed running state", async () => {
  const f = await fixture("yours");
  await act(async () => f.socket.message({ type: "tc-update", ...target, state: state({ running: true }) }));
  await act(async () => f.result.current.stopFreerun());
  expect(f.result.current.stopping).toBe(true);
  expect(f.result.current.state.running).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(f.result.current.stopping).toBe(false);
  expect(f.result.current.lastError).toMatch(/not confirmed/);
});
it("keeps ownership unavailable until the relay confirms a claim", async () => {
  const f = await fixture();
  await act(async () => f.result.current.claimControl());
  expect(f.result.current.control).toBe("available");
  expect(f.result.current.pending).toBe("claim-control");
  await act(async () => f.socket.message({ type: "control-status", ...target, control: "yours" }));
  expect(f.result.current.control).toBe("yours");
  expect(f.result.current.pending).toBeNull();
  await act(async () => f.result.current.releaseControl());
  await act(async () => f.socket.message({ type: "control-status", ...target, control: "available" }));
  expect(f.result.current.control).toBe("available");
  expect(f.result.current.pending).toBeNull();
});
it("stops the local feed immediately when backgrounded and never resumes it automatically", async () => {
  const f = await fixture("yours");
  await act(async () => f.result.current.startFreerun());
  await act(async () => {
    f.socket.message({ type: "master-status", ...target, granted: true });
    f.socket.message({ type: "tc-update", ...target, state: state({ running: true }) });
  });
  f.socket.close = () => { f.socket.readyState = 2; };
  const before = f.socket.sent.length;
  await act(async () => { appState.currentState = "background"; appState.listener("background"); });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(f.socket.sent.length).toBe(before);
  expect(f.result.current.isMaster).toBe(false);
  expect(f.result.current.status).toBe("offline");
  await act(async () => { appState.currentState = "active"; appState.listener("active"); });
  await act(async () => { sockets[1].open(); hydrate(sockets[1]); });
  expect(sockets[1].sent).toEqual([]);
});
it("closes late authentication from a timed out attempt", async () => {
  let finish;
  authenticate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const f = renderHook(() => useTimecodeRelay("org", undefined, target));
  await act(async () => vi.advanceTimersByTimeAsync(13_001));
  await act(async () => { sockets[0].open(); hydrate(sockets[0]); });
  const late = new Socket();
  await act(async () => finish(late));
  expect(late.readyState).toBe(3);
  expect(f.result.current.status).toBe("connected");
});
it("refreshes idle state and detects a connection that stops replying", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(f.socket.sent.at(-1)).toMatchObject({ type: "sync" });
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(f.result.current.status).not.toBe("connected");
  expect(f.result.current.lastError).toMatch(/stopped responding/);
});
it("keeps healthy idle connections after a refreshed snapshot", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  await act(async () => hydrate(f.socket));
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(f.result.current.status).toBe("connected");
});
it("invalidates live control on a missing sequence without applying the partial update", async () => {
  const f = await fixture();
  await act(async () => f.socket.message({ type: "hydrate", ...target, state: state(), events: [event()], control: "yours", sequence: 2, previousSequence: null }));
  await act(async () => f.socket.message({ type: "tc-update", ...target, state: state({ totalFrames: 999 }), sequence: 4, previousSequence: 3 }));
  expect(f.result.current.state.totalFrames).toBe(0);
  expect(f.result.current.status).not.toBe("connected");
  expect(f.result.current.lastError).toMatch(/missed/);
});
it("manual retry fences off old messages and clears their deadlines", async () => {
  const f = await fixture();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  await act(async () => f.result.current.retryConnection());
  const next = sockets.at(-1);
  await act(async () => { next.open(); hydrate(next, { totalFrames: 50 }); });
  await act(async () => hydrate(f.socket, { totalFrames: 999 }));
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(f.result.current.status).toBe("connected");
  expect(f.result.current.state.totalFrames).toBe(50);
});
it("keeps a command rejection visible across a healthy refresh", async () => {
  const f = await fixture("yours");
  await act(async () => f.socket.message({ type: "command-rejected", ...target, action: "start", error: "Review the held position." }));
  await act(async () => hydrate(f.socket));
  expect(f.result.current.lastError).toBe("Review the held position.");
  await act(async () => f.result.current.dismissCommandError());
  expect(f.result.current.lastError).toBeNull();
});
it.each([
  [{ executionStatus: "failed" }, "Failed"],
  [{ executionStatus: "dispatching" }, "Sending"],
  [{ executionStatus: "acknowledged", fired: true }, "Fired"],
  [{ enabled: false }, "Disabled"],
  [{ enabled: false, fired: true, executionStatus: "acknowledged" }, "Disabled"],
  [{ skipped: true }, "Skipped"],
  [{}, "Armed"],
])("renders the actual cue execution state %j", (overrides, expected) => {
  expect(contract.timecodeEventStatus(contract.parseMobileTimecodeEvent(event(overrides)))).toBe(expected);
});
