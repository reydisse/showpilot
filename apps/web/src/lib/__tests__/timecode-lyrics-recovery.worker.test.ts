import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { TestTimecodeRelay } from "@/test/worker-entry";
import { timecodeFixture, claimTimecodeControl } from "@/test/timecode-fixtures";
import { lyricsReviewState } from "@showpilot/shared";
import type { TimecodeState } from "@/types/timecode";
afterEach(abortAllDurableObjects);
async function fixture() {
  const room = await timecodeFixture();
  const songId = crypto.randomUUID(), sections = [0, 1, 2].map(() => crypto.randomUUID());
  await env.DB.prepare("INSERT INTO song (id,orgId,title) VALUES (?,?,'Recovery song')").bind(songId, room.orgId).run();
  for (const i of [2, 0, 1]) await env.DB.prepare("INSERT INTO song_section (id,songId,orgId,label,lyrics,sortOrder) VALUES (?,?,?,?,?,?)")
    .bind(sections[i], songId, room.orgId, `Section ${i}`, `Line ${i}a\n\nLine ${i}b`, i).run();
  const command = async (action: string, payload?: unknown) => {
    const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
  };
  const state = async () => (await room.stub.fetch(room.url("/state"))).json<TimecodeState>();
  const show = async (index = 0) => command("set-lyrics", { songId, songTitle: "Recovery song", sectionId: sections[index], sectionLabel: `Section ${index}`, lyrics: `Line ${index}a\n\nLine ${index}b` });
  await show();
  const review = async (operation: "next" | "previous" | "clear" = "next") => {
    const lyrics = (await state()).lyrics;
    if (!lyrics) throw new Error("Fixture lyrics missing");
    return { requestId: crypto.randomUUID(), showId: room.target.showId, serviceDate: room.target.serviceDate, operation, expected: lyricsReviewState(lyrics) };
  };
  const delay = (ms: number) => runInDurableObject(room.stub, instance => {
    if (!(instance instanceof TestTimecodeRelay)) throw new Error("Wrong fixture");
    instance.setLyricsLookupDelay(ms);
  });
  const lookups = () => runInDurableObject(room.stub, instance => {
    if (!(instance instanceof TestTimecodeRelay)) throw new Error("Wrong fixture");
    return instance.getLyricsLookupCount();
  });
  return { ...room, command, state, show, review, sections, songId, delay, lookups };
}
it("recovers Next after restart without advancing twice or replacing a later manual section", async () => {
  const f = await fixture(), input = await f.review();
  const first = await f.command("control-lyrics", input);
  expect(first).toMatchObject({ status: 200, body: { requestId: input.requestId, outcome: "applied", userId: f.authority.userId } });
  expect((await f.state()).lyrics).toMatchObject({ sectionId: f.sections[1], lyrics: "Line 1a\n\nLine 1b", manual: true });
  await f.show(2); const later = (await f.state()).lyrics;
  await evictDurableObject(f.stub);
  expect(await f.command("control-lyrics", input)).toEqual(first);
  expect((await f.state()).lyrics).toEqual(later);
});
it("recovers Clear without erasing a newly displayed song", async () => {
  const f = await fixture(), input = await f.review("clear");
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.state()).lyrics).toBeNull();
  await f.show(2); const later = (await f.state()).lyrics;
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.state()).lyrics).toEqual(later);
});
it("commits concurrent identical requests once and rejects changed intent", async () => {
  const f = await fixture(), input = await f.review();
  const results = await Promise.all([f.command("control-lyrics", input), f.command("control-lyrics", input)]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[1]);
  expect(await f.command("control-lyrics", { ...input, operation: "clear" })).toMatchObject({ status: 409, body: { outcome: "conflict" } });
});
it("only applies one of two independently reviewed Next commands and keeps the room usable", async () => {
  const f = await fixture(), input = await f.review();
  const results = await Promise.all([f.command("control-lyrics", input), f.command("control-lyrics", { ...input, requestId: crypto.randomUUID() })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[1]);
  expect(await f.command("control-lyrics", await f.review("previous"))).toMatchObject({ status: 200 });
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[0]);
});
it.each(["revision", "generationKey", "updatedAt", "sectionId", "songId"])("rejects stale %s and retains the original rejection", async field => {
  const f = await fixture(), input = await f.review();
  const changed = { ...input, expected: { ...input.expected, [field]: field === "updatedAt" ? -1 : "stale" } };
  expect(await f.command("control-lyrics", changed)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  await f.show(1);
  expect(await f.command("control-lyrics", changed)).toMatchObject({ status: 409 });
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[1]);
});
it.each(["showId", "serviceDate"])("rejects a mismatched %s before changing lyrics", async field => {
  const f = await fixture(), input = await f.review();
  expect(await f.command("control-lyrics", { ...input, [field]: "other" })).toMatchObject({ status: 409 });
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[0]);
});
it.each(["showId", "serviceDate", "expected"])("requires %s on a recoverable request", async field => {
  const f = await fixture(), input = await f.review();
  expect(await f.command("control-lyrics", { ...input, [field]: undefined })).toMatchObject({ status: 400 });
});
it("retains boundary errors, and rejects malformed identities without breaking later commands", async () => {
  const f = await fixture(), input = await f.review("previous");
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 400, body: { outcome: "rejected", message: "Already at the first song section." } });
  await f.show(1);
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect(await f.command("control-lyrics", { ...await f.review(), requestId: "invalid" })).toMatchObject({ status: 400 });
  expect(await f.command("control-lyrics", await f.review())).toMatchObject({ status: 200 });
});
it("rechecks current authority before returning a saved receipt", async () => {
  const f = await fixture(), input = await f.review();
  await f.command("control-lyrics", input);
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  expect((await f.command("control-lyrics", input)).status).toBe(401);
});

it("does not install a slow lookup over newer lyrics and allows automation Stop during the lookup", async () => {
  const f = await fixture(), input = await f.review();
  await f.delay(300);
  const pending = f.command("control-lyrics", input);
  await expect.poll(() => f.lookups()).toBe(1);
  await f.command("set-triggers-enabled", { enabled: false });
  await f.show(2); const newer = (await f.state()).lyrics;
  expect(await pending).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.state()).lyrics).toEqual(newer);
  expect((await f.state()).triggersEnabled).toBe(false);
});
it("bounds song lookup and never installs its late result", async () => {
  const f = await fixture(), input = await f.review(), before = (await f.state()).lyrics;
  await f.delay(5200);
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 400, body: { outcome: "rejected", message: "Song sections could not load in time. Try again." } });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect((await f.state()).lyrics).toEqual(before);
  expect(await f.command("control-lyrics", input)).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect(await f.lookups()).toBe(1);
}, 10000);
it("rechecks membership after a delayed song lookup", async () => {
  const f = await fixture(), input = await f.review();
  await f.delay(200);
  const pending = f.command("control-lyrics", input);
  await expect.poll(() => f.lookups()).toBe(1);
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  expect(await pending).toMatchObject({ status: 400, body: { outcome: "rejected" } });
});

it("requires an identity when a request includes an explicit show review", async () => {
  const f = await fixture(), input = await f.review();
  expect(await f.command("control-lyrics", { ...input, requestId: undefined })).toMatchObject({ status: 400 });
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[0]);
});
it("rejects a lookup after control changes without breaking the new owner's commands", async () => {
  const f = await fixture(), input = await f.review();
  await f.delay(300); const pending = f.command("control-lyrics", input);
  await expect.poll(f.lookups).toBe(1);
  f.controlSocket?.send(JSON.stringify({ type: "command", action: "release-control" }));
  await expect.poll(async () => (await (await f.stub.fetch(f.url("/lyrics-controls"))).json<{ canControl: boolean }>()).canControl).toBe(false);
  await claimTimecodeControl(f.stub, f.url("/ws"));
  expect(await pending).toMatchObject({ status: 400 });
  expect((await f.state()).lyrics?.sectionId).toBe(f.sections[0]);
  expect(await f.command("control-lyrics", await f.review("clear"))).toMatchObject({ status: 200 });
});
