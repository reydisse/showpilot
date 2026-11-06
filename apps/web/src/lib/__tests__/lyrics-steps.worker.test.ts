import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { lyricsReviewState } from "@/lib/lyrics-control";
import { buildSongAutomationEvents } from "@/lib/song-cues";

afterEach(abortAllDurableObjects);
const zero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const format = { frameRate: 30, dropFrame: "ndf" } as const;

async function fixture() {
  const test = await timecodeFixture();
  const songId = crypto.randomUUID();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await env.DB.prepare("INSERT INTO song (id,orgId,title) VALUES (?,?,'Fixture song')").bind(songId, test.orgId).run();
  // Insert out of order to prove steps use sortOrder, not row or cue order.
  for (const index of [2, 0, 1]) {
    await env.DB.prepare("INSERT INTO song_section (id,songId,orgId,label,lyrics,sortOrder) VALUES (?,?,?,?,?,?)")
      .bind(ids[index], songId, test.orgId, `Section ${index + 1}`, `Line ${index + 1}a\nLine ${index + 1}b`, index * 10).run();
  }
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    expect(response.status).toBe(status); await response.text();
  };
  const show = async (index = 0, selectedSong = songId) => command("set-lyrics", { songId: selectedSong, songTitle: "Fixture song", sectionId: ids[index], sectionLabel: `Section ${index + 1}`, lyrics: `Line ${index + 1}a\nLine ${index + 1}b` });
  const add = (id: string, action: "lyrics-next-section" | "lyrics-previous-section", enabled = true) => command("add-event", { id, action, enabled, label: action, triggerTimecode: zero, payload: {} });
  return { ...test, songId, ids, command, show, add,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

it("steps in saved song order with one lyric replacement and no clear, including timed consecutive steps", async () => {
  const test = await fixture();
  await test.show();
  const output: { type: string; lyrics?: { sectionId: string; lyrics: string } }[] = [];
  test.controlSocket?.addEventListener("message", message => { const data = JSON.parse(String(message.data)); if (data.type === "lyrics-update" || data.type === "lyrics-clear") output.push(data); });
  await test.add("next-1", "lyrics-next-section");
  await test.add("next-2", "lyrics-next-section");
  await test.command("start");
  await test.command("feed-tc", { timecode: zero, format });
  await expect.poll(() => output.length).toBe(2);
  expect(output.map(message => message.type)).toEqual(["lyrics-update", "lyrics-update"]);
  expect(output.map(message => message.lyrics?.sectionId)).toEqual(test.ids.slice(1));
  expect(output.map(message => message.lyrics?.lyrics)).toEqual(["Line 2a\nLine 2b", "Line 3a\nLine 3b"]);
  expect((await test.state()).lyrics).toMatchObject({ sectionId: test.ids[2], nextLabel: "" });
  expect((await test.events()).every(event => event.fired && event.executionStatus === "acknowledged")).toBe(true);
  await test.add("previous", "lyrics-previous-section");
  await test.command("fire-event", { id: "previous" });
  expect((await test.state()).lyrics).toMatchObject({ sectionId: test.ids[1], nextLabel: "Section 3" });
  await test.command("feed-tc", { timecode: { ...zero, frames: 1 }, format });
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[1]);
});

it.each([
  ["lyrics-previous-section", 0, "first"],
  ["lyrics-next-section", 2, "last"],
] as const)("keeps the output at the %s song boundary", async (action, index, boundary) => {
  const test = await fixture();
  await test.show(index);
  const before = (await test.state()).lyrics;
  await test.add("boundary", action);
  await test.command("fire-event", { id: "boundary" });
  expect((await test.state()).lyrics).toEqual(before);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionRetryable: false, executionError: `Already at the ${boundary} song section.` });
});

it("honors disable, kill switch, explicit retry and reviewed re-fire", async () => {
  const test = await fixture();
  await test.add("next", "lyrics-next-section", false);
  await test.command("fire-event", { id: "next" }, 400);
  await test.command("set-event-enabled", { id: "next", enabled: true });
  await test.command("fire-event", { id: "next" });
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionError: "Show a song section before stepping lyrics." });
  await test.show();
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("fire-event", { id: "next" }, 400);
  await test.command("set-triggers-enabled", { enabled: true });
  await test.command("retry-event", { id: "next" });
  const first = (await test.events())[0];
  expect(first.fired).toBe(true);
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[1]);
  await test.command("fire-event", { id: "next" }, 400);
  await test.command("rearm-event", { id: "next", confirmed: true, expected: { fired: true, skipped: false, executionId: first.executionId } });
  await test.command("fire-event", { id: "next" });
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[2]);
});

it("cannot read lyrics from another organization or advance a removed section", async () => {
  const test = await fixture();
  const other = await fixture();
  await test.command("set-lyrics", { songId: other.songId, songTitle: "Stale", sectionId: other.ids[0], sectionLabel: "Stale", lyrics: "Retained output" });
  await test.add("next", "lyrics-next-section");
  await test.command("fire-event", { id: "next" });
  expect((await test.state()).lyrics?.lyrics).toBe("Retained output");
  expect((await test.events())[0].executionStatus).toBe("failed");
  await test.show();
  await env.DB.prepare("DELETE FROM song_section WHERE id=? AND orgId=?").bind(test.ids[0], test.orgId).run();
  await test.command("retry-event", { id: "next" });
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[0]);
  expect((await test.events())[0].executionStatus).toBe("failed");
});

it("preserves the song load's scoped clear and follows a saved section reorder", async () => {
  const test = await fixture();
  await test.command("add-event", { id: "show", action: "lyrics-goto", label: "Show", sourceKey: "song-load", triggerTimecode: zero, payload: { songId: test.songId, songTitle: "Fixture song", sectionId: test.ids[0], sectionLabel: "Section 1", lyrics: "Line 1" } });
  await test.command("fire-event", { id: "show" });
  await env.DB.prepare("UPDATE song_section SET sortOrder=5 WHERE id=? AND orgId=?").bind(test.ids[2], test.orgId).run();
  await test.add("next", "lyrics-next-section");
  await test.command("fire-event", { id: "next" });
  expect((await test.state()).lyrics).toMatchObject({ generationKey: "song-load", sectionId: test.ids[2], nextLabel: "Section 2", manual: false });
  await test.command("add-event", { id: "clear", action: "lyrics-clear", label: "Clear", triggerTimecode: zero, payload: { generationKey: "song-load" } });
  await test.command("fire-event", { id: "clear" });
  expect((await test.state()).lyrics).toBeNull();
});

it("lets the owning session step and clear reviewed lyrics without an intermediate blank", async () => {
  const test = await fixture();
  await test.show();
  const output: string[] = [];
  test.controlSocket?.addEventListener("message", message => {
    const data = JSON.parse(String(message.data));
    if (data.type === "lyrics-update" || data.type === "lyrics-clear") output.push(data.type);
  });
  for (const [operation, expectedSection] of [["next", test.ids[1]], ["previous", test.ids[0]]] as const) {
    const before = (await test.state()).lyrics;
    if (!before) throw new Error("Missing fixture lyrics");
    await test.command("control-lyrics", { operation, expected: lyricsReviewState(before) });
    const after = (await test.state()).lyrics;
    expect(after).toMatchObject({ sectionId: expectedSection, manual: true });
    expect(after?.revision).not.toBe(before.revision);
    expect(after?.lyrics).toContain("\n");
  }
  await expect.poll(() => output).toEqual(["lyrics-update", "lyrics-update"]);
  const current = (await test.state()).lyrics;
  if (!current) throw new Error("Missing fixture lyrics");
  await test.command("control-lyrics", { operation: "clear", expected: lyricsReviewState(current) });
  expect((await test.state()).lyrics).toBeNull();
  await expect.poll(() => output).toEqual(["lyrics-update", "lyrics-update", "lyrics-clear"]);
});

it("accepts only one of two concurrent clicks reviewing the same section", async () => {
  const test = await fixture();
  await test.show();
  const current = (await test.state()).lyrics;
  if (!current) throw new Error("Missing fixture lyrics");
  const body = JSON.stringify({ action: "control-lyrics", payload: { operation: "next", expected: lyricsReviewState(current) } });
  const responses = await Promise.all([0, 1].map(() => test.stub.fetch(test.url("/command"), { method: "POST", body })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  await Promise.all(responses.map(response => response.text()));
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[1]);
  await test.command("control-lyrics", { operation: "clear", expected: lyricsReviewState(current) }, 400);
  expect((await test.state()).lyrics?.sectionId).toBe(test.ids[1]);
});

it("rejects stale revisions even if the song, section and timestamp match", async () => {
  const test = await fixture();
  await test.show();
  const current = (await test.state()).lyrics;
  if (!current) throw new Error("Missing fixture lyrics");
  await test.command("control-lyrics", {
    operation: "clear", expected: { ...lyricsReviewState(current), revision: crypto.randomUUID() },
  }, 400);
  expect((await test.state()).lyrics).toEqual(current);
});

it("exposes only control availability and refuses display readers or another session", async () => {
  const test = await fixture();
  await test.show();
  await test.add("private-cue", "lyrics-next-section");
  const status = await test.stub.fetch(test.url("/lyrics-controls"));
  const body = await status.json();
  expect(body).toMatchObject({ canControl: true });
  expect(JSON.stringify(body)).not.toContain("private-cue");
  const reader = await test.stub.fetch(test.url("/lyrics-controls", "read"));
  expect(reader.status).toBe(401);
  await reader.text();
  const other = await seedRelayMember(test.orgId, crypto.randomUUID());
  const otherUrl = (path: string) => {
    const url = test.url(path);
    url.searchParams.set("authUserId", other.userId);
    url.searchParams.set("authSessionId", other.sessionId);
    return url;
  };
  expect(await (await test.stub.fetch(otherUrl("/lyrics-controls"))).json()).toMatchObject({ canControl: false });
  const current = (await test.state()).lyrics;
  if (!current) throw new Error("Missing fixture lyrics");
  const rejected = await test.stub.fetch(otherUrl("/command"), {
    method: "POST", body: JSON.stringify({ action: "control-lyrics", payload: { operation: "clear", expected: lyricsReviewState(current) } }),
  });
  expect(rejected.status).toBe(409);
  await rejected.text();
  expect((await test.state()).lyrics).toEqual(current);
});

it.each([false, true])("runs a loaded song's timed clear without erasing a later manual override: %s", async manualOverride => {
  const test = await fixture();
  const events = buildSongAutomationEvents({ song: { id: test.songId, title: "Fixture song" },
    cues: [{ id: "verse", triggerFrame: 0, section: { id: test.ids[0], label: "Section 1", lyrics: "First\nSecond" }, ppSlideIndex: null }],
    format, target: "native", cueMapId: "map", clearAfterFrames: 2, toleranceFrames: 0 });
  await test.command("replace-event-group", { sourceKey: events[0].sourceKey, events });
  await test.command("start");
  await test.command("feed-tc", { timecode: zero, format });
  expect((await test.state()).lyrics).toMatchObject({ generationKey: events[0].sourceKey, lyrics: "First\nSecond" });
  if (manualOverride) await test.show(1);
  await test.command("feed-tc", { timecode: { ...zero, frames: 2 }, format });
  if (manualOverride) {
    expect((await test.state()).lyrics).toMatchObject({ sectionId: test.ids[1], manual: true });
    await test.command("add-event", { id: "manual-clear", action: "lyrics-clear", label: "Clear current lyrics", triggerTimecode: zero, payload: {} });
    await test.command("fire-event", { id: "manual-clear" });
  }
  expect((await test.state()).lyrics).toBeNull();
  expect((await test.events()).every(event => event.fired)).toBe(true);
});
