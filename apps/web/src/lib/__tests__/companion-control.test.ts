import { describe, it, expect } from "vitest";
import {
  timerStart,
  timerStop,
  rundownNext,
  rundownPrevious,
  timerAdd,
  timerSubtract,
  setLyrics,
  triggerLowerThird,
  clearLowerThird,
  kioskBlank,
  streamGoLive,
  streamStop,
  getState,
  type CompanionDeps,
  type RelayState,
  type RelayTimer,
} from "../companion-control";
import type { LowerThirdPayload } from "@/lib/lowerthirds";

interface RecordedCommand {
  orgId: string;
  action: string;
  payload?: Record<string, unknown>;
}

function makeDeps(opts: {
  state?: RelayState;
  cloudEnabled?: boolean;
  lyrics?: boolean;
  lowerThird?: LowerThirdPayload | null;
  kioskBlanked?: boolean;
  stream?: { connected: number; total: number };
  goLive?: { status: number; results?: { id: string; success: boolean; error?: string }[]; error?: string };
}) {
  const commands: RecordedCommand[] = [];
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };

  const timer: RelayTimer = opts.state?.timer ?? {
    playback: "stop",
    currentItemId: null,
    elapsed: 0,
    startedAt: null,
    pausedAt: null,
    mode: "count-down",
  };
  const state: RelayState = opts.state ?? { items: [], timer };

  const deps: CompanionDeps = {
    async relayCommand(orgId, action, payload) {
      commands.push({ orgId, action, payload });
    },
    async relayState() {
      return state;
    },
    async setLyrics(orgId, enabled) {
      record("setLyrics", orgId, enabled);
    },
    async getLyrics() {
      return opts.lyrics ?? false;
    },
    async isCloudEnabled() {
      return opts.cloudEnabled ?? false;
    },
    async triggerLowerThird(orgId, payload, triggeredBy) {
      record("triggerLowerThird", orgId, payload, triggeredBy);
      return { ...(payload as object), state: "live" } as LowerThirdPayload;
    },
    async clearLowerThird(orgId) {
      record("clearLowerThird", orgId);
    },
    async getLowerThird() {
      return opts.lowerThird ?? null;
    },
    async setKioskBlank(orgId, blanked) {
      record("setKioskBlank", orgId, blanked);
    },
    async getKioskBlank() {
      return opts.kioskBlanked ?? false;
    },
    async streamGoLive() {
      return opts.goLive ?? { status: 200, results: [] };
    },
    async streamStop(orgId) {
      record("streamStop", orgId);
    },
    async streamStatus() {
      return opts.stream ?? { connected: 0, total: 0 };
    },
  };

  return { deps, commands, calls };
}

const items3: RelayState["items"] = [
  { id: "a", title: "Welcome", status: "upcoming", duration: 300000 },
  { id: "b", title: "Worship", status: "upcoming", duration: 600000 },
  { id: "c", title: "Sermon", status: "upcoming", duration: 1800000 },
];

const playing = (currentItemId: string): RelayTimer => ({
  playback: "play",
  currentItemId,
  elapsed: 0,
  startedAt: 1000,
  pausedAt: null,
  mode: "count-down",
});

describe("transport endpoints forward the right relay command + orgId", () => {
  it("timer/start with itemId → timer-start", async () => {
    const { deps, commands } = makeDeps({ state: { items: items3, timer: playing("a") } });
    await timerStart(deps, "org-1", "b");
    expect(commands[0]).toMatchObject({ orgId: "org-1", action: "timer-start", payload: { itemId: "b" } });
  });

  it("timer/start with no itemId while paused → timer-resume", async () => {
    const paused: RelayTimer = { ...playing("a"), playback: "pause", startedAt: null, elapsed: 5000, pausedAt: 6000 };
    const { deps, commands } = makeDeps({ state: { items: items3, timer: paused } });
    await timerStart(deps, "org-1");
    expect(commands[0]).toMatchObject({ action: "timer-resume" });
  });

  it("timer/start with no itemId, stopped with a current item → restart current", async () => {
    const stoppedWithCurrent: RelayTimer = {
      playback: "stop", currentItemId: "b", elapsed: 0, startedAt: null, pausedAt: null, mode: "count-down",
    };
    const { deps, commands } = makeDeps({ state: { items: items3, timer: stoppedWithCurrent } });
    await timerStart(deps, "org-1");
    expect(commands[0]).toMatchObject({ action: "timer-start", payload: { itemId: "b" } });
  });

  it("timer/start with nothing live → starts the first item", async () => {
    const stopped: RelayTimer = {
      playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, pausedAt: null, mode: "count-down",
    };
    const { deps, commands } = makeDeps({ state: { items: items3, timer: stopped } });
    await timerStart(deps, "org-1");
    expect(commands[0]).toMatchObject({ action: "timer-start", payload: { itemId: "a" } });
  });

  it("timer/start with no items → 409, no command sent", async () => {
    const { deps, commands } = makeDeps({ state: { items: [], timer: {
      playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, pausedAt: null, mode: "count-down",
    } } });
    const r = await timerStart(deps, "org-1");
    expect(r.status).toBe(409);
    expect(commands).toHaveLength(0);
  });

  it("timer/stop → timer-stop", async () => {
    const { deps, commands } = makeDeps({ state: { items: items3, timer: playing("a") } });
    await timerStop(deps, "org-9");
    expect(commands[0]).toMatchObject({ orgId: "org-9", action: "timer-stop" });
  });

  it("rundown/next → timer-next, rundown/previous → timer-prev", async () => {
    const { deps, commands } = makeDeps({ state: { items: items3, timer: playing("b") } });
    await rundownNext(deps, "org-1");
    await rundownPrevious(deps, "org-1");
    expect(commands[0].action).toBe("timer-next");
    expect(commands[1].action).toBe("timer-prev");
  });

  it("timer/add and timer/subtract map to timer-adjust deltaMs", async () => {
    const { deps, commands } = makeDeps({ state: { items: items3, timer: playing("a") } });
    await timerAdd(deps, "org-1", 90);
    await timerSubtract(deps, "org-1", 30);
    expect(commands[0]).toMatchObject({ action: "timer-adjust", payload: { deltaMs: 90000 } });
    expect(commands[1]).toMatchObject({ action: "timer-adjust", payload: { deltaMs: -30000 } });
  });

  it("threads the caller's orgId (cross-org isolation)", async () => {
    const { deps, commands } = makeDeps({ state: { items: items3, timer: playing("a") } });
    await timerStop(deps, "org-b");
    expect(commands.every((c) => c.orgId === "org-b")).toBe(true);
  });
});

describe("lyrics", () => {
  it("setLyrics persists the flag and echoes it", async () => {
    const { deps, calls } = makeDeps({});
    const r = await setLyrics(deps, "org-1", true);
    expect(calls.setLyrics?.[0]).toEqual(["org-1", true]);
    expect(r.body).toMatchObject({ ok: true, lyricsEnabled: true });
  });
});

describe("lower thirds respect the cloud_enabled gate", () => {
  const payload = { id: "lt1", type: "freetext", line1: "Hi", style: "default" };

  it("trigger is blocked with 403 when cloud_enabled = 0", async () => {
    const { deps, calls } = makeDeps({ cloudEnabled: false });
    const r = await triggerLowerThird(deps, "org-1", payload as never);
    expect(r.status).toBe(403);
    expect(calls.triggerLowerThird).toBeUndefined();
  });

  it("trigger goes through when cloud_enabled = 1", async () => {
    const { deps, calls } = makeDeps({ cloudEnabled: true });
    const r = await triggerLowerThird(deps, "org-1", payload as never, "companion");
    expect(r.status).toBe(200);
    expect(calls.triggerLowerThird?.[0]?.[0]).toBe("org-1");
  });

  it("clear is blocked with 403 when cloud_enabled = 0", async () => {
    const { deps, calls } = makeDeps({ cloudEnabled: false });
    const r = await clearLowerThird(deps, "org-1");
    expect(r.status).toBe(403);
    expect(calls.clearLowerThird).toBeUndefined();
  });

  it("clear goes through when cloud_enabled = 1", async () => {
    const { deps, calls } = makeDeps({ cloudEnabled: true });
    const r = await clearLowerThird(deps, "org-1");
    expect(r.status).toBe(200);
    expect(calls.clearLowerThird?.[0]).toEqual(["org-1"]);
  });
});

describe("kiosk blank + stream + state", () => {
  it("kioskBlank persists the flag", async () => {
    const { deps, calls } = makeDeps({});
    const r = await kioskBlank(deps, "org-1", true);
    expect(calls.setKioskBlank?.[0]).toEqual(["org-1", true]);
    expect(r.body).toMatchObject({ ok: true, blanked: true });
  });

  it("streamGoLive surfaces partial failures + connected count", async () => {
    const { deps } = makeDeps({
      goLive: { status: 200, results: [
        { id: "yt", success: true },
        { id: "fb", success: false, error: "bad key" },
      ] },
    });
    const r = await streamGoLive(deps, "org-1");
    expect(r.body).toMatchObject({ ok: true, connected: 1, total: 2 });
  });

  it("streamGoLive bubbles the 409 no-input case", async () => {
    const { deps } = makeDeps({ goLive: { status: 409, error: "No live input configured" } });
    const r = await streamGoLive(deps, "org-1");
    expect(r.status).toBe(409);
  });

  it("streamStop disconnects", async () => {
    const { deps, calls } = makeDeps({});
    await streamStop(deps, "org-1");
    expect(calls.streamStop?.[0]).toEqual(["org-1"]);
  });

  it("getState aggregates timer, items, lyrics, LT, kiosk + stream", async () => {
    const { deps } = makeDeps({
      state: { items: items3, timer: playing("b") },
      lyrics: true,
      lowerThird: { id: "lt1", type: "freetext", style: "default", state: "live" } as LowerThirdPayload,
      kioskBlanked: true,
      stream: { connected: 2, total: 3 },
    });
    const r = await getState(deps, "org-1");
    expect(r.body).toMatchObject({
      ok: true,
      currentItem: { id: "b", title: "Worship" },
      nextItem: { id: "c", title: "Sermon" },
      lyricsEnabled: true,
      lowerThird: { id: "lt1", state: "live" },
      kioskBlanked: true,
      stream: { connected: 2, total: 3 },
    });
  });
});
