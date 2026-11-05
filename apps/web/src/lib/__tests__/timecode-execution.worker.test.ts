import { timecodeFixture } from "@/test/timecode-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationEvent, TimecodeCommand } from "@/types/timecode";

afterEach(async () => {
  vi.unstubAllGlobals();
  await abortAllDurableObjects();
});

async function timeline() {
  const { orgId, stub, url } = await timecodeFixture();
  return {
    orgId,
    stub,
    url,
    async command(action: TimecodeCommand, payload?: Record<string, unknown>) {
      const response = await stub.fetch(new Request(url("/command"), {
        method: "POST", body: JSON.stringify({ action, payload }),
      }));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    },
    async events() {
      return (await stub.fetch(url("/events"))).json<AutomationEvent[]>();
    },
    async display() {
      return (await stub.fetch(url("/state", "read"))).json();
    },
  };
}

const atZero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const tick = { timecode: atZero, format: { frameRate: 30, dropFrame: "ndf" } };

describe("automation acknowledgement", () => {
  it("loads demo cues atomically only into an empty stopped timeline", async () => {
    const test = await timeline();
    const demo = { id: "demo-1", sourceKey: "demo", action: "stage-clear", label: "Demo", triggerTimecode: atZero, payload: {} };
    const payload = { sourceKey: "demo", events: [demo], requireStopped: true, requireEmpty: true, expectedFormat: tick.format };
    await test.command("start");
    await test.command("replace-event-group", payload);
    expect(await test.events()).toEqual([]);
    await test.command("stop");
    await test.command("add-event", { ...demo, id: "real-cue", sourceKey: "real-show" });
    await test.command("replace-event-group", payload);
    expect((await test.events()).map((event) => event.id)).toEqual(["real-cue"]);
    await test.command("remove-event", { id: "real-cue" });
    await test.command("replace-event-group", payload);
    expect((await test.events()).map((event) => event.id)).toEqual(["demo-1"]);
  });

  it("does not replace a song group if the clock started or its format changed before delivery", async () => {
    const test = await timeline();
    const original = { id: "original", sourceKey: "song-map", action: "stage-clear", label: "Original", triggerTimecode: atZero, payload: {} };
    const replacement = { ...original, id: "replacement", label: "Replacement" };
    await test.command("replace-event-group", { sourceKey: "song-map", events: [original] });
    await test.command("start");
    await test.command("replace-event-group", { sourceKey: "song-map", events: [replacement], requireStopped: true, expectedFormat: tick.format });
    expect((await test.events()).map((event) => event.id)).toEqual(["original"]);
    await test.command("stop");
    await test.command("replace-event-group", { sourceKey: "song-map", events: [replacement], requireStopped: true, expectedFormat: { frameRate: 25, dropFrame: "ndf" } });
    expect((await test.events()).map((event) => event.id)).toEqual(["original"]);
    await test.command("replace-event-group", { sourceKey: "song-map", events: [replacement], requireStopped: true, expectedFormat: tick.format });
    expect((await test.events()).map((event) => event.id)).toEqual(["replacement"]);
  });

  it("echoes the canonical event after a lost-ack save retry without duplicating it", async () => {
    const test = await timeline();
    const event = { id: "retry-save", action: "stage-clear", label: "Original", triggerTimecode: atZero, payload: {} };
    await test.command("add-event", event);
    const response = await test.stub.fetch(new Request(test.url("/ws"), { headers: { Upgrade: "websocket" } }));
    if (!response.webSocket) throw new Error("Missing timecode socket");
    const socket = response.webSocket;
    const next = (type: string) => new Promise<Record<string, unknown>>((resolve) => {
      const handler = (message: MessageEvent) => {
        const data = JSON.parse(String(message.data));
        if (data.type !== type) return;
        socket.removeEventListener("message", handler); resolve(data);
      };
      socket.addEventListener("message", handler);
    });
    const hydration = next("hydrate"); socket.accept(); await hydration;
    const echo = next("events-update");
    socket.send(JSON.stringify({ type: "command", action: "add-event", payload: { ...event, label: "Retry must not replace existing event" } }));
    expect(await echo).toMatchObject({ events: [{ id: "retry-save", label: "Original" }] });
    expect(await test.events()).toHaveLength(1);
    socket.close();
  });

  it("keeps same-output show and clear cues in timeline order", async () => {
    const test = await timeline();
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    await (await graphics.fetch(new Request("https://test/test/delay", { method: "POST", body: "150" }))).text();
    for (const action of ["lower-third-show", "lower-third-clear"]) {
      await test.command("add-event", { action, label: action, triggerTimecode: atZero, payload: { line1: "Temporary graphic" } });
    }
    await test.command("feed-tc", tick);
    expect((await test.events()).every((event) => event.fired)).toBe(true);
    expect(await (await graphics.fetch("https://test/current")).json()).toMatchObject({ current: null });
  });

  it("times out a hung webhook and ignores its late acknowledgement", async () => {
    const requests = vi.fn<typeof fetch>(async () => {
      // Deliberately ignore AbortSignal, as an RPC or remote device might.
      await new Promise((resolve) => setTimeout(resolve, 5200));
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", requests);
    const test = await timeline();
    await test.command("add-event", { id: "hung", action: "custom-webhook", label: "Hung", triggerTimecode: atZero, payload: { url: "https://hooks.example.com/hung" } });
    await test.command("feed-tc", tick);
    const event = (await test.events())[0];
    expect(event).toMatchObject({ fired: false, executionStatus: "failed", executionRetryable: false });
    expect(event.executionError).toContain("timed out after 5000 ms");
    expect(event.executionDurationMs).toBeGreaterThanOrEqual(5000);
    expect(requests.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionAttempts: 1 });
    expect(await test.display()).toMatchObject({ automation: { status: "failed", failedCueCount: 1 } });
  }, 10000);

  it("runs a later lyric cue while a same-frame webhook is still awaiting acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return Response.json({ ok: true });
    }));
    const test = await timeline();
    await test.command("add-event", { id: "slow", action: "custom-webhook", label: "Slow", triggerTimecode: atZero, payload: { url: "https://hooks.example.com/cue" } });
    await test.command("add-event", {
      id: "lyrics", action: "lyrics-goto", label: "Verse", triggerTimecode: atZero,
      payload: { songId: "song", songTitle: "Song", sectionId: "verse", sectionLabel: "Verse", lyrics: "Visible immediately" },
    });
    const feed = test.command("feed-tc", tick);
    try {
      await expect.poll(async () => (await test.events()).find((event) => event.id === "lyrics")?.fired, { timeout: 1000 }).toBe(true);
      expect((await test.events()).find((event) => event.id === "slow")).toMatchObject({ fired: false, executionStatus: "dispatching" });
      expect(await test.display()).toMatchObject({ running: true, lyrics: { lyrics: "Visible immediately" } });
    } finally {
      await feed;
    }
  });

  it.each(["lower-third-show", "lower-third-clear"] as const)("does not acknowledge a rejected %s", async (action) => {
    const test = await timeline();
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "503" }));
    await test.command("add-event", {
      action, label: "Graphics", triggerTimecode: atZero,
      payload: { line1: "Private graphic", secret: "never-on-display" },
    });
    await test.command("feed-tc", tick);
    expect(await test.events()).toEqual([expect.objectContaining({
      fired: false, executionStatus: "failed", executionError: expect.stringContaining("503"),
    })]);
    const display = await test.display();
    expect(display).toMatchObject({ automation: { status: "failed", failedCueCount: 1 } });
    expect(JSON.stringify(display)).not.toContain("never-on-display");
    expect(display).not.toHaveProperty("events");
  });

  it("reports the real rundown relay's rejected start instead of a success", async () => {
    const test = await timeline();
    await test.command("add-event", {
      action: "rundown-start-item", label: "Start missing item", triggerTimecode: atZero,
      payload: { itemId: "nonexistent-item" },
    });
    await test.command("feed-tc", tick);
    expect(await test.events()).toEqual([expect.objectContaining({
      fired: false, executionStatus: "failed", executionError: expect.stringContaining("400"),
    })]);
    expect(await test.display()).toMatchObject({ automation: { status: "failed", failedCueCount: 1 } });
  });

  it("fails an unsafe webhook without dispatching it", async () => {
    const test = await timeline();
    await test.command("add-event", {
      action: "custom-webhook", label: "Blocked webhook", triggerTimecode: atZero,
      payload: { url: "https://127.0.0.1/private" },
    });
    await test.command("feed-tc", tick);
    expect(await test.events()).toEqual([expect.objectContaining({ fired: false, executionStatus: "failed" })]);
  });

  it("marks a successful graphics command fired only after the relay acknowledges", async () => {
    const test = await timeline();
    await test.command("add-event", {
      action: "lower-third-show", label: "Graphics", triggerTimecode: atZero,
      payload: { line1: "Test graphic" },
    });
    await test.command("feed-tc", tick);
    expect(await test.events()).toEqual([expect.objectContaining({ fired: true, executionStatus: "acknowledged" })]);
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    expect(await (await graphics.fetch("https://test/current")).json()).toMatchObject({ current: { line1: "Test graphic", state: "live" } });
    expect(await test.display()).toMatchObject({ automation: { status: "ok", failedCueCount: 0 } });
  });

  it("keeps the clock running during the kill switch and skips missed cues on re-enable", async () => {
    const test = await timeline();
    for (const frame of [0, 10]) await test.command("add-event", {
      id: `cue-${frame}`, action: "lower-third-show", label: `Cue ${frame}`,
      triggerTimecode: { ...atZero, frames: frame }, payload: { line1: `Cue ${frame}` },
    });
    await test.command("set-triggers-enabled", { enabled: false });
    await test.command("feed-tc", tick);
    await test.command("feed-tc", { ...tick, timecode: { ...atZero, frames: 5 } });
    expect((await test.events()).every((event) => !event.fired)).toBe(true);
    expect(await test.display()).toMatchObject({ running: true, display: "00:00:00:05" });
    await test.command("set-triggers-enabled", { enabled: true });
    await test.command("feed-tc", { ...tick, timecode: { ...atZero, frames: 10 } });
    expect(await test.events()).toEqual([
      expect.objectContaining({ id: "cue-0", fired: false }),
      expect.objectContaining({ id: "cue-10", fired: true }),
    ]);
    await test.command("feed-tc", tick);
    await test.command("feed-tc", { ...tick, timecode: { ...atZero, frames: 10 } });
    expect((await test.events())[1].executionAttempts).toBe(1);
  });

  it("disables one event without disabling other events", async () => {
    const test = await timeline();
    for (const id of ["disabled", "enabled"]) await test.command("add-event", {
      id, action: "lower-third-show", label: id, triggerTimecode: atZero, payload: { line1: id },
    });
    await test.command("set-event-enabled", { id: "disabled", enabled: false });
    await test.command("feed-tc", tick);
    expect(await test.events()).toEqual([
      expect.objectContaining({ id: "disabled", enabled: false, fired: false }),
      expect.objectContaining({ id: "enabled", enabled: true, fired: true }),
    ]);
    await test.command("retry-event", { id: "disabled" });
    expect((await test.events())[0].fired).toBe(false);
  });

  it("retries only the selected cue, and respects the kill switch", async () => {
    const test = await timeline();
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "503" }));
    for (const id of ["retry", "leave-failed"]) await test.command("add-event", {
      id, action: "lower-third-show", label: id, triggerTimecode: atZero, payload: { line1: id },
    });
    await test.command("feed-tc", tick);
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "200" }));
    await test.command("set-triggers-enabled", { enabled: false });
    await test.command("retry-event", { id: "retry" });
    expect((await test.events()).every((event) => !event.fired)).toBe(true);
    await test.command("set-triggers-enabled", { enabled: true });
    await test.command("retry-event", { id: "retry" });
    expect(await test.events()).toEqual([
      expect.objectContaining({ id: "retry", fired: true, executionStatus: "acknowledged" }),
      expect.objectContaining({ id: "leave-failed", fired: false, executionStatus: "failed" }),
    ]);
  });

  it("bounds automatic retries by attempt count and frame tolerance", async () => {
    const test = await timeline();
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "503" }));
    await test.command("add-event", {
      action: "lower-third-show", label: "Retry window", triggerTimecode: atZero,
      payload: { line1: "Test" }, toleranceFrames: 300,
    });
    for (let i = 0; i < 5; i++) await test.command("feed-tc", tick);
    expect((await test.events())[0]).toMatchObject({ fired: false, executionAttempts: 3 });
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "200" }));
    await test.command("feed-tc", tick);
    expect((await test.events())[0].fired).toBe(false);

    const expired = await timeline();
    await expired.command("add-event", {
      id: "expired", action: "rundown-start-item", label: "Expired", triggerTimecode: atZero,
      payload: { itemId: "missing" }, toleranceFrames: 2,
    });
    await expired.command("feed-tc", tick);
    await expired.command("feed-tc", { ...tick, timecode: { ...atZero, frames: 5 } });
    expect((await expired.events())[0].executionAttempts).toBe(1);
  });

  it("does not let a client forge acknowledgement fields through an edit", async () => {
    const test = await timeline();
    await test.command("add-event", { id: "cue", action: "lower-third-clear", label: "Clear", triggerTimecode: atZero, payload: {} });
    await test.command("update-event", { id: "cue", updates: {
      id: "forged-id", fired: true, executionStatus: "acknowledged", executionAttempts: 100,
      executionRetryable: true, executionId: "forged-execution", label: "Renamed",
    } });
    expect(await test.events()).toEqual([expect.objectContaining({
      id: "cue", fired: false, executionStatus: "scheduled", executionAttempts: 0, label: "Renamed",
    })]);
    expect((await test.events())[0].executionId).toBeUndefined();
  });

  it("retries a transient rejection on a later feed inside the tolerance window", async () => {
    const test = await timeline();
    const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "503" }));
    await test.command("add-event", {
      action: "lower-third-show", label: "Recover", triggerTimecode: atZero,
      payload: { line1: "Recovered" }, toleranceFrames: 300,
    });
    await test.command("feed-tc", tick);
    const first = (await test.events())[0];
    expect(first).toMatchObject({ fired: false, executionRetryable: true });
    await graphics.fetch(new Request("https://test/test/status", { method: "POST", body: "200" }));
    await test.command("feed-tc", { ...tick, timecode: { ...atZero, frames: 1 } });
    expect((await test.events())[0]).toMatchObject({ fired: true, executionAttempts: 2, executionId: first.executionId });
  });

  it("preserves disabled automation and treats an interrupted acknowledgement as uncertain after restart", async () => {
    const test = await timeline();
    await test.command("add-event", { id: "interrupted", action: "lower-third-clear", label: "Clear", triggerTimecode: atZero, payload: {} });
    await test.command("set-triggers-enabled", { enabled: false });
    await runInDurableObject(test.stub, async (_, storageState) => {
      const stored = await storageState.storage.get<{ state: unknown; events: AutomationEvent[] }>("timecode");
      if (!stored) throw new Error("Expected a persisted timeline");
      stored.events[0].executionStatus = "dispatching";
      await storageState.storage.put("timecode", stored);
    });
    await evictDurableObject(test.stub);
    const state = await (await test.stub.fetch(test.url("/state"))).json();
    expect(state).toMatchObject({ triggersEnabled: false, running: false });
    expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionAttempts: 3 });
    await test.command("set-triggers-enabled", { enabled: true });
    await test.command("feed-tc", tick);
    expect((await test.events())[0]).toMatchObject({ fired: false, executionAttempts: 3 });
  });
});
