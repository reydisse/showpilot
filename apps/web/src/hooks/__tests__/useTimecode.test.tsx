import { MidiAccessFixture, MidiInputFixture } from "@/test/midi-fixture";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimecode } from "../useTimecode";
import { InternalTimecodeSource } from "@/lib/timecode-sources/internal-source";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { useEffect } from "react";
import { framesToTimecode } from "@/lib/timecode";
import { TimecodeProvider, useShowTimecode } from "@/components/timecode/TimecodeContext";
import { getTimecodeShows } from "@/lib/timecode-shows";

vi.mock("@/lib/timecode-shows", () => ({ getTimecodeShows: vi.fn() }));

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(data); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
}
const state: TimecodeState = {
  showId: "test-show", serviceDate: "2026-11-05",
  timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, display: "00:00:00:00",
  totalFrames: 0, running: false, source: "internal-freerun", format: { frameRate: 30, dropFrame: "ndf" },
  triggersEnabled: true, serverTime: 1, lyrics: null,
};
const event: Omit<AutomationEvent, "id" | "fired" | "triggerFrame"> = {
  enabled: true, label: "Welcome", action: "stage-message", payload: { message: "Welcome" },
  triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, toleranceFrames: 5,
};
function hydrate(socket: Socket) { socket.open(); socket.receive({ type: "hydrate", state, events: [] }); }
function hook() { return renderHook(() => useTimecode({ orgId: "test-org", showId: "test-show", enabled: true })); }

beforeEach(() => {
  Socket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("timecode connection honesty", () => {
  it("shows control separately from generator ownership and rejects edits while another tab controls the show", async () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { socket.open(); socket.receive({ type: "hydrate", state, events: [], control: "other", sequence: 1, previousSequence: null }); });
    expect(result.current.control).toBe("other");
    expect(result.current.connected).toBe(true);
    let save: Promise<void> = Promise.resolve();
    act(() => { save = result.current.addEvent(event); });
    await expect(save).rejects.toThrow("Another operator");
    expect(socket.sent).toEqual([]);
    act(() => socket.receive({ type: "control-status", control: "available" }));
    act(() => result.current.claimControl());
    expect(JSON.parse(socket.sent[0])).toMatchObject({ action: "claim-control" });
    act(() => socket.receive({ type: "control-status", control: "yours" }));
    expect(result.current.control).toBe("yours");
    expect(result.current.isMaster).toBe(false);
    expect(result.current.connected).toBe(true); // Unsequenced ownership metadata is not a data gap.
    act(() => result.current.releaseControl());
    expect(JSON.parse(socket.sent[1])).toMatchObject({ action: "release-control" });
    act(() => socket.close());
    expect(result.current.control).toBeNull();
  });

  it("reports a lost control race immediately and keeps an event form's draft instead of waiting for a timeout", async () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    let save: Promise<void> = Promise.resolve();
    act(() => { save = result.current.addEvent(event); });
    act(() => socket.receive({ type: "command-rejected", action: "add-event", error: "Another operator controls timecode." }));
    await expect(save).rejects.toThrow("Another operator");
    expect(result.current.lastError).toBe("Another operator controls timecode.");
    expect(result.current.events).toEqual([]);
  });

  it("refreshes a missing sequence from a full hydrate and confirms a save whose event echo was missed", async () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { socket.open(); socket.receive({ type: "hydrate", state, events: [], sequence: 5, previousSequence: null }); });
    let saved: Promise<void> = Promise.resolve();
    act(() => { saved = result.current.addEvent({ ...event, id: "resync-cue" }); });
    act(() => socket.receive({ type: "tc-update", state, sequence: 7, previousSequence: 6 }));
    expect(result.current.connected).toBe(false);
    expect(socket.sent.map(message => JSON.parse(message)).at(-1)).toEqual({ type: "sync", lastSeenSequence: 5 });
    const recovered = { ...event, id: "resync-cue", fired: false, triggerFrame: 300 };
    await act(async () => {
      socket.receive({ type: "hydrate", state, events: [recovered], sequence: 7, previousSequence: 7 });
      await saved;
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.events).toEqual([recovered]);
    act(() => socket.receive({ type: "events-update", events: [], sequence: 6, previousSequence: 5 }));
    expect(result.current.events).toEqual([recovered]);
  });

  it("pins the provider selection while show metadata refreshes and keeps routed children mounted", async () => {
    const shows = ["test-show", "evening"].map(id => ({ id, name: id, serviceDate: "2026-11-05", scheduledStartTime: null }));
    vi.mocked(getTimecodeShows).mockResolvedValue({ shows, activeShowId: "test-show" });
    const mounted = vi.fn();
    function Operator() {
      const clock = useShowTimecode();
      useEffect(() => { mounted(); }, []);
      return <>
        <output aria-label="Selected timecode show">{clock.showId}</output>
        <button onClick={() => clock.selectShow("evening")}>Select evening</button>
        <button onClick={() => clock.selectShow("another-org-show")}>Select unknown show</button>
        <button onClick={() => clock.startFreerun()}>Start selected clock</button>
        <button onClick={clock.refreshShows}>Refresh show list</button>
      </>;
    }
    await act(async () => { render(<TimecodeProvider orgId="test-org" enabled><Operator /></TimecodeProvider>); });
    act(() => hydrate(Socket.instances[0]));
    expect(screen.getByLabelText("Selected timecode show").textContent).toBe("test-show");
    await act(async () => {
      vi.mocked(getTimecodeShows).mockResolvedValue({ shows, activeShowId: "evening" });
      fireEvent.click(screen.getByRole("button", { name: "Refresh show list" }));
    });
    expect(screen.getByLabelText("Selected timecode show").textContent).toBe("test-show");
    fireEvent.click(screen.getByRole("button", { name: "Select unknown show" }));
    expect(Socket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Start selected clock" }));
    fireEvent.click(screen.getByRole("button", { name: "Select evening" }));
    expect(Socket.instances).toHaveLength(1);
    act(() => Socket.instances[0].receive({ type: "master-status", granted: false }));
    fireEvent.click(screen.getByRole("button", { name: "Select evening" }));
    expect(Socket.instances).toHaveLength(2);
    expect(screen.getByLabelText("Selected timecode show").textContent).toBe("evening");
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("closes the old show, rejects pending edits, and ignores late echoes when selecting another show", async () => {
    const { result, rerender } = renderHook(({ showId }) => useTimecode({ orgId: "test-org", showId, enabled: true }), {
      initialProps: { showId: "test-show" },
    });
    const original = Socket.instances[0];
    expect(new URL(original.url).searchParams.get("showId")).toBe("test-show");
    act(() => hydrate(original));
    let save: Promise<void> = Promise.resolve();
    act(() => { save = result.current.addEvent(event); });
    const rejected = expect(save).rejects.toThrow("workspace changed");
    await act(async () => { rerender({ showId: "evening" }); });
    await rejected;
    expect(original.readyState).toBe(3);
    expect(result.current.state).toBeNull();
    expect(result.current.events).toEqual([]);
    act(() => {
      original.receive({ type: "hydrate", state, events: [{ ...event, id: "old", triggerFrame: 300, fired: false }] });
      original.receive({ type: "master-status", granted: true });
    });
    expect(result.current.state).toBeNull();
    expect(result.current.isMaster).toBe(false);
    const selected = Socket.instances[1];
    expect(new URL(selected.url).searchParams.get("showId")).toBe("evening");
    act(() => {
      selected.open();
      selected.receive({ type: "hydrate", state: { ...state, showId: "evening" }, events: [] });
    });
    expect(result.current.connected).toBe(true);
    act(() => original.receive({ type: "lyrics-update", lyrics: { lyrics: "Wrong show" } }));
    expect(result.current.state?.lyrics).toBeNull();
    act(() => result.current.setTriggersEnabled(false));
    expect(selected.sent).toHaveLength(1);
    expect(original.sent).toHaveLength(1);
  });

  it("rejects a room that hydrates with the wrong show identity", () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => {
      socket.open();
      socket.receive({ type: "hydrate", state: { ...state, showId: "other-show" }, events: [] });
    });
    expect(socket.readyState).toBe(3);
    expect(result.current.connected).toBe(false);
    expect(result.current.state).toBeNull();
    expect(result.current.lastError).toContain("show mismatch");
  });

  it("keeps the local source alive through format review and waiting for the next accepted feed", () => {
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { hydrate(socket); result.current.startFreerun(); });
    act(() => {
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...state, running: true } });
    });
    expect(result.current.isMaster).toBe(true);
    const stop = vi.spyOn(InternalTimecodeSource.prototype, "stop");
    for (const status of ["format-mismatch", "waiting"] as const) {
      act(() => socket.receive({ type: "tc-update", state: { ...state, running: false, signal: { status, lastFeedAt: null } } }));
      expect(result.current.isMaster).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    }
    act(() => result.current.setFormat({ frameRate: 25, dropFrame: "ndf" }, state.format, "reviewed-input"));
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ action: "set-format", payload: { confirmed: true, expectedFormat: state.format, expectedIncomingFormatId: "reviewed-input" } });
    act(() => socket.receive({ type: "tc-update", state: { ...state, running: false, signal: { status: "idle", lastFeedAt: null } } }));
    expect(result.current.isMaster).toBe(false);
    expect(stop).toHaveBeenCalled();
  });

  it("shows source rejection and cancels the pending local generator", () => {
    const start = vi.spyOn(InternalTimecodeSource.prototype, "start");
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { hydrate(socket); result.current.startFreerun(); });
    act(() => socket.receive({ type: "command-rejected", action: "set-source", error: "This timecode source is not implemented." }));
    expect(result.current.lastError).toBe("This timecode source is not implemented.");
    expect(result.current.generatorPending).toBeNull();
    act(() => {
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...state, running: true } });
    });
    expect(start).not.toHaveBeenCalled();
    expect(result.current.isMaster).toBe(false);
  });

  it("keeps the large clock, header clock, and generator button consistent", () => {
    function Controls() {
      const clock = useTimecode({ orgId: "test-org", showId: "test-show", enabled: true });
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

  it("sends each actual MIDI observation once and keeps listening after signal loss", async () => {
    const input = new MidiInputFixture("mtc");
    vi.stubGlobal("navigator", { requestMIDIAccess: async () => new MidiAccessFixture(input) });
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => hydrate(socket));
    await act(async () => { await result.current.startMtc("mtc"); });
    act(() => {
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...state, source: "mtc", running: true } });
    });
    const midiFrame = (frame: number) => {
      const nibbles = [frame, 0, 0, 0, 0, 0, 0, 6];
      nibbles.forEach((value, index) => input.send([0xf1, (index << 4) | value]));
    };
    const feeds = () => socket.sent.map(message => JSON.parse(message)).filter(message => message.action === "feed-tc");
    act(() => { midiFrame(1); vi.advanceTimersByTime(100); });
    expect(feeds()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(feeds()).toHaveLength(1);
    act(() => socket.receive({ type: "tc-update", state: { ...state, source: "mtc", running: false, signal: { status: "timecode-lost", lastFeedAt: 1 } } }));
    expect(result.current.isMaster).toBe(true);
    act(() => { midiFrame(2); vi.advanceTimersByTime(100); });
    expect(feeds()).toHaveLength(2);
    expect(feeds()[1].payload.timecode.frames).toBe(2);
  });

  it("shows MTC signal loss with a stop control while holding the last frame", () => {
    const lost: TimecodeState = { ...state, source: "mtc", signal: { status: "timecode-stalled", lastFeedAt: 1 } };
    render(<>
      <TimecodeDisplay state={lost} connected size="large" />
      <TimecodeDisplay state={lost} connected />
      <TimecodeSourceSelector isMaster connected pending={null} running={false} signal={lost.signal} source="mtc"
        format={state.format} mtcSupported={false} onStartFreerun={() => {}} onStopGenerator={() => {}}
        onStartMtc={async () => {}} onSetFormat={() => {}} />
    </>);
    expect(screen.getByRole("alert").textContent).toContain("MTC signal lost");
    expect(screen.getAllByRole("status", { name: "Timecode signal lost" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Stop Generator" })).toBeTruthy();
    expect(screen.getByText("Signal lost · clock held")).toBeTruthy();
  });

  it.each<TimecodeState["format"]>([
    { frameRate: 24, dropFrame: "ndf" }, { frameRate: 25, dropFrame: "ndf" },
    { frameRate: 29.97, dropFrame: "df" }, { frameRate: 30, dropFrame: "ndf" },
  ])("resumes the exact held frame after Stop at $frameRate $dropFrame", format => {
    const held: TimecodeState = { ...state, format, totalFrames: 1800, timecode: framesToTimecode(1800, format) };
    const { result } = hook();
    const socket = Socket.instances[0];
    act(() => { socket.open(); socket.receive({ type: "hydrate", state: held, events: [] }); });
    const resume = () => {
      result.current.startFreerun();
      socket.receive({ type: "master-status", granted: true });
      socket.receive({ type: "tc-update", state: { ...held, running: true } });
      vi.advanceTimersByTime(100);
    };
    act(resume);
    act(() => {
      result.current.stopGenerator();
      socket.receive({ type: "master-status", granted: false });
      socket.receive({ type: "tc-update", state: held });
    });
    act(resume);
    const feeds = socket.sent.map(message => JSON.parse(message)).filter(message => message.action === "feed-tc");
    expect(feeds).toHaveLength(2);
    expect(feeds.map(message => message.payload.totalFrames)).toEqual([1800, 1800]);
    expect(feeds[1].payload.timecode).toEqual(held.timecode);
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
