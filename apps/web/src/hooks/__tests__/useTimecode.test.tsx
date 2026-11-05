import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimecode } from "../useTimecode";
import { InternalTimecodeSource } from "@/lib/timecode-sources/internal-source";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor() { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(data); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
}
const state: TimecodeState = {
  timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, display: "00:00:00:00",
  totalFrames: 0, running: false, source: "internal-freerun", format: { frameRate: 30, dropFrame: "ndf" },
  triggersEnabled: true, serverTime: 1, lyrics: null,
};
const event: Omit<AutomationEvent, "id" | "fired" | "triggerFrame"> = {
  enabled: true, label: "Welcome", action: "stage-message", payload: { message: "Welcome" },
  triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, toleranceFrames: 5,
};
function hydrate(socket: Socket) { socket.open(); socket.receive({ type: "hydrate", state, events: [] }); }
function hook() { return renderHook(() => useTimecode({ orgId: "test-org", enabled: true })); }

beforeEach(() => {
  Socket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("timecode connection honesty", () => {
  it("keeps the large clock, header clock, and generator button consistent", () => {
    function Controls() {
      const clock = useTimecode({ orgId: "test-org", enabled: true });
      return <>
        <TimecodeDisplay state={clock.state} connected={clock.connected} size="large" />
        <TimecodeDisplay state={clock.state} connected={clock.connected} />
        <TimecodeSourceSelector isMaster={clock.isMaster} running={clock.state?.running ?? false}
          connected={clock.connected} pending={clock.generatorPending} format={state.format} mtcSupported={false}
          onStartFreerun={clock.startFreerun} onStopGenerator={clock.stopGenerator}
          onStartMtc={clock.startMtc} onSetFormat={clock.setFormat} />
      </>;
    }
    render(<Controls />);
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    expect(screen.getAllByRole("status", { name: "Timecode stopped" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Start Internal Generator" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeTruthy();
    act(() => {
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...state, running: true } });
    });
    expect(screen.getAllByRole("status", { name: "Timecode running" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Stop Generator" })).toBeTruthy();
    act(() => socket.close());
    expect(screen.getAllByRole("status", { name: "Timecode disconnected" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Start Internal Generator" }).closest("fieldset")).toHaveProperty("disabled", true);
  });

  it("does not run a rejected or unconfirmed generator start", () => {
    const start = vi.spyOn(InternalTimecodeSource.prototype, "start");
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { hydrate(socket); result.current.startFreerun(); });
    act(() => socket.receive({ type: "master-status", granted: false }));
    expect(start).not.toHaveBeenCalled();
    expect(result.current.lastError).toContain("Another source");
    act(() => result.current.startFreerun());
    act(() => vi.advanceTimersByTime(5_000));
    expect(start).not.toHaveBeenCalled();
    expect(result.current.generatorPending).toBeNull();
    expect(result.current.lastError).toContain("not confirmed");
    expect(socket.readyState).toBe(3);
    act(() => {
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...state, running: true } });
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("closes a MIDI input whose permission completes after disconnection", async () => {
    let permit: () => void = () => {};
    vi.spyOn(MtcSource.prototype, "start").mockImplementation(() => new Promise<void>((resolve) => { permit = resolve; }));
    const stop = vi.spyOn(MtcSource.prototype, "stop");
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    let starting: Promise<void> = Promise.resolve();
    act(() => { starting = result.current.startMtc("midi-input"); });
    const rejected = expect(starting).rejects.toThrow("disconnected");
    await act(async () => { socket.close(); permit(); await rejected; });
    expect(stop).toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(result.current.isMaster).toBe(false);
  });

  it("expires an unconfirmed edit and waits for the exact replacement group", async () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    let saving: Promise<void> = Promise.resolve();
    act(() => { saving = result.current.addEvent(event); });
    const timedOut = expect(saving).rejects.toThrow("not confirmed");
    await act(async () => { vi.advanceTimersByTime(5_000); await timedOut; });
    const replacement: AutomationEvent = { ...event, id: "new-group", sourceKey: "song:1", fired: false, triggerFrame: 300 };
    let done = false;
    act(() => { saving = result.current.replaceEventGroup("song:1", [replacement]).then(() => { done = true; }); });
    await act(async () => socket.receive({ type: "events-update", events: [{ ...replacement, id: "old-group" }] }));
    expect(done).toBe(false);
    await act(async () => { socket.receive({ type: "events-update", events: [replacement] }); await saving; });
    expect(done).toBe(true);
    act(() => socket.receive({ type: "tc-update", state: { ...state, running: true } }));
    const sentCount = socket.sent.length;
    await expect(result.current.replaceEventGroup("song:1", [replacement])).rejects.toThrow("Stop the clock");
    expect(socket.sent).toHaveLength(sentCount);
  });

  it("cannot start a local clock while disconnected or before relay state arrives", () => {
    const start = vi.spyOn(InternalTimecodeSource.prototype, "start");
    const { result } = hook();
    act(() => result.current.startFreerun());
    expect(start).not.toHaveBeenCalled();
    expect(result.current.isMaster).toBe(false);
    expect(result.current.lastError).toContain("disconnected");
    act(() => Socket.instances[0].open());
    expect(result.current.connected).toBe(false);
    act(() => result.current.startFreerun());
    expect(start).not.toHaveBeenCalled();
  });

  it("starts only after the lease grant and running-state echo, and stops on disconnect", () => {
    const start = vi.spyOn(InternalTimecodeSource.prototype, "start");
    const stop = vi.spyOn(InternalTimecodeSource.prototype, "stop");
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    act(() => result.current.startFreerun(5_000));
    expect(start).not.toHaveBeenCalled();
    act(() => socket.receive({ type: "master-status", granted: true }));
    expect(start).not.toHaveBeenCalled();
    act(() => socket.receive({ type: "tc-update", state: { ...state, running: true } }));
    expect(start).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(result.current.isMaster).toBe(true);
    expect(result.current.state?.running).toBe(true);
    act(() => socket.close());
    expect(stop).toHaveBeenCalled();
    expect(result.current.isMaster).toBe(false);
    expect(result.current.connected).toBe(false);
    act(() => vi.advanceTimersByTime(1_000));
    act(() => hydrate(Socket.instances[1]));
    expect(Socket.instances[1].sent).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("leaves an event save pending until its id is echoed and rejects on disconnect", async () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    let confirmed = false;
    let save: Promise<void>;
    act(() => { save = Promise.resolve(result.current.addEvent(event)).then(() => { confirmed = true; }); });
    await act(async () => {});
    expect(confirmed).toBe(false);
    const command = JSON.parse(socket.sent.at(-1) ?? "{}");
    expect(command.payload.id).toEqual(expect.any(String));
    act(() => socket.receive({ type: "events-update", events: [] }));
    expect(confirmed).toBe(false);
    await act(async () => {
      socket.receive({ type: "events-update", events: [{ ...command.payload, fired: false, triggerFrame: 300 }] });
      await save;
    });
    expect(confirmed).toBe(true);
    let second: Promise<void>;
    act(() => { second = Promise.resolve(result.current.addEvent({ ...event, label: "Second" })); });
    const rejected = expect(second!).rejects.toThrow("disconnected");
    act(() => socket.close());
    await rejected;
  });
});
