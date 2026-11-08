import { nextFixtureAddress } from "@/test/fixture-address";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { getPrisma } from "../db";
import { createSong, deleteSong, deleteSongSection, getSong, importProPresenterSong, reorderSongSections, saveSongCueMap, saveSongDraft, saveSongMetadata, saveSongSection } from "../songs";
import { runSongWrite } from "../song-write.server";

const request = vi.hoisted(() => ({ cookie: "" }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; },
      handler: (fn: (input: unknown) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
afterEach(() => { request.cookie = ""; });

async function fixture() {
  const prisma = getPrisma(); const userId = crypto.randomUUID(); const orgId = crypto.randomUUID();
  const email = `${userId}@example.test`; const password = "Song-fixture-password-92!";
  await prisma.user.create({ data: { id: userId, name: "Song operator", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Song fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const input = { orgId, title: "Original song", artist: "Fixture", ccliNumber: "", bpm: 75, keySignature: "C",
    sections: [{ label: "Verse", lyrics: "First\nSecond" }, { label: "Chorus", lyrics: "Chorus first\nChorus second" }] };
  return { prisma, orgId, userId, input };
}
// Keep cold password hashing and the real login outside the behavior timeout.
// Each test still gets its own organization, member and authenticated session.
let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  authenticated = await fixture();
});

async function rejecting(sql: string, check: () => Promise<void>) {
  await env.DB.prepare(`CREATE TRIGGER fixture_reject_song_write ${sql}`).run();
  try { await check(); } finally { await env.DB.exec("DROP TRIGGER fixture_reject_song_write"); }
}
const format = { frameRate: 30, dropFrame: "ndf" } as const;
async function existingSong(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await createSong({ data: f.input });
  let song = await getSong({ data: { orgId: f.orgId, songId: created.id } });
  await saveSongCueMap({ data: { orgId: f.orgId, songId: song.id, name: "Original map", ...format,
    cues: [{ sectionId: song.sections[0].id, triggerTc: "00:00:01:00" }] } });
  song = await getSong({ data: { orgId: f.orgId, songId: created.id } });
  return song;
}

it("rolls back manual song creation if any lyric section fails", async () => {
  const f = authenticated;
  await rejecting(`BEFORE INSERT ON song_section WHEN NEW.orgId='${f.orgId}' AND NEW.label='Chorus'
    BEGIN SELECT RAISE(ABORT,'fixture section insert failed'); END;`, async () => {
    await expect(createSong({ data: f.input })).rejects.toThrow();
    expect(await f.prisma.song.count({ where: { orgId: f.orgId } })).toBe(0);
    expect(await f.prisma.songSection.count({ where: { orgId: f.orgId } })).toBe(0);
  });
});

it("rolls back the whole section reorder on a later update failure", async () => {
  const f = authenticated; const song = await existingSong(f);
  await rejecting(`BEFORE UPDATE ON song_section WHEN NEW.orgId='${f.orgId}' AND NEW.id='${song.sections[0].id}'
    BEGIN SELECT RAISE(ABORT,'fixture reorder failed'); END;`, async () => {
    await expect(reorderSongSections({ data: { orgId: f.orgId, songId: song.id, sectionIds: song.sections.map(s => s.id).reverse() } })).rejects.toThrow();
    expect(await getSong({ data: { orgId: f.orgId, songId: song.id } })).toEqual(song);
  });
});

it("preserves the old cue map name and cues if replacement insertion fails", async () => {
  const f = authenticated; const song = await existingSong(f);
  await rejecting(`BEFORE INSERT ON song_cue WHEN NEW.orgId='${f.orgId}'
    BEGIN SELECT RAISE(ABORT,'fixture cue insert failed'); END;`, async () => {
    await expect(saveSongCueMap({ data: { orgId: f.orgId, songId: song.id, cueMapId: song.cueMaps[0].id, name: "New map", ...format,
      cues: [{ sectionId: song.sections[1].id, triggerTc: "00:00:02:00" }] } })).rejects.toThrow();
    expect(await getSong({ data: { orgId: f.orgId, songId: song.id } })).toEqual(song);
  });
});

it("rolls back metadata, lyrics and cues together when saving a draft fails", async () => {
  const f = authenticated; const song = await existingSong(f);
  await rejecting(`BEFORE UPDATE ON song_section WHEN NEW.orgId='${f.orgId}' AND NEW.id='${song.sections[1].id}'
    BEGIN SELECT RAISE(ABORT,'fixture draft failed'); END;`, async () => {
    await expect(saveSongDraft({ data: { orgId: f.orgId, songId: song.id, title: "Changed title", artist: "Changed artist", ccliNumber: "", bpm: 120, keySignature: "G",
      sections: song.sections.map(s => ({ id: s.id, label: s.label, lyrics: "Changed\nlyrics", sourceSlideIndex: s.sourceSlideIndex })),
      cueMap: { cueMapId: song.cueMaps[0].id, name: "Changed map", ...format, cues: [] },
    } })).rejects.toThrow();
    expect(await getSong({ data: { orgId: f.orgId, songId: song.id } })).toEqual(song);
  });
});

it("rolls back destructive ProPresenter replacement including cascaded mapped cues", async () => {
  const f = authenticated; const original = await existingSong(f); const uuid = crypto.randomUUID();
  await f.prisma.song.update({ where: { id: original.id }, data: { ppPresentationUuid: uuid } });
  const song = await getSong({ data: { orgId: f.orgId, songId: original.id } });
  await rejecting(`BEFORE INSERT ON song_section WHEN NEW.orgId='${f.orgId}' AND NEW.label='Reject'
    BEGIN SELECT RAISE(ABORT,'fixture import failed'); END;`, async () => {
    await expect(importProPresenterSong({ data: { orgId: f.orgId, strategy: "replace", presentation: { uuid, name: "Changed title", slides: [
      { index: 0, sourceId: "first", label: "New verse", text: "New first", notes: "" },
      { index: 1, sourceId: "second", label: "Reject", text: "New second", notes: "" },
    ] } } })).rejects.toThrow();
    expect(await getSong({ data: { orgId: f.orgId, songId: song.id } })).toEqual(song);
  });
});

it("concurrent creation retries commit one song and one receipt", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  const replies = await Promise.all([createSong({ data }), createSong({ data })]);
  expect(replies[0]).toEqual(replies[1]);
  expect(await f.prisma.song.count({ where: { orgId: f.orgId } })).toBe(1);
  expect(await f.prisma.songSection.count({ where: { orgId: f.orgId } })).toBe(2);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM song_write_receipt WHERE orgId=?").bind(f.orgId).first<{ n: number }>())?.n).toBe(1);
  await expect(createSong({ data: { ...data, title: "Different song" } })).rejects.toThrow("different song changes");
});

it("rolls back its receipt with a failed write so the same request can retry", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  await rejecting(`BEFORE INSERT ON song_section WHEN NEW.orgId='${f.orgId}' AND NEW.label='Chorus'
    BEGIN SELECT RAISE(ABORT,'fixture section insert failed'); END;`, async () => {
    await expect(createSong({ data })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT requestId FROM song_write_receipt WHERE orgId=?").bind(f.orgId).first()).toBeNull();
  });
  const result = await createSong({ data });
  expect(await createSong({ data })).toEqual(result);
  expect(await f.prisma.song.count({ where: { orgId: f.orgId } })).toBe(1);
});

it("never recreates a removed song when its saved creation is retried", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  const { id } = await createSong({ data });
  const removal = { orgId: f.orgId, songId: id, requestId: crypto.randomUUID() };
  await deleteSong({ data: removal });
  await expect(createSong({ data })).rejects.toThrow("removed");
  await expect(deleteSong({ data: removal })).resolves.toEqual({ ok: true });
  expect(await f.prisma.song.count({ where: { orgId: f.orgId } })).toBe(0);
});

it("replays a saved draft without overwriting a later edit or creating another map", async () => {
  const f = authenticated; const song = await existingSong(f);
  const data = { ...f.input, songId: song.id, requestId: crypto.randomUUID(), title: "First saved title",
    sections: song.sections.map(s => ({ id: s.id, label: s.label, lyrics: s.lyrics, sourceSlideIndex: s.sourceSlideIndex })),
    cueMap: { name: "New map", ...format, cues: [] },
  };
  const first = await saveSongDraft({ data });
  await saveSongMetadata({ data: { ...f.input, songId: song.id, title: "Later title" } });
  const newer = await getSong({ data: { orgId: f.orgId, songId: song.id } });
  expect(await saveSongDraft({ data })).toEqual(first);
  expect(await getSong({ data: { orgId: f.orgId, songId: song.id } })).toEqual(newer);
  expect(newer.cueMaps).toHaveLength(2);
  await f.prisma.songCueMap.delete({ where: { id: first.cueMapId } });
  await expect(saveSongDraft({ data })).rejects.toThrow("cue map has been removed");
});

it("recovers a new section once and never restores it after deletion", async () => {
  const f = authenticated; const song = await existingSong(f);
  const data = { orgId: f.orgId, songId: song.id, requestId: crypto.randomUUID(), label: "Added", lyrics: "One\nTwo" };
  const replies = await Promise.all([saveSongSection({ data }), saveSongSection({ data })]);
  expect(replies[0].id).toBe(replies[1].id);
  expect(await f.prisma.songSection.count({ where: { songId: song.id } })).toBe(3);
  const removal = { orgId: f.orgId, songId: song.id, sectionId: replies[0].id, requestId: crypto.randomUUID() };
  await deleteSongSection({ data: removal });
  await expect(deleteSongSection({ data: removal })).resolves.toEqual({ ok: true });
  await expect(saveSongSection({ data })).rejects.toThrow("removed");
});

it("checks current permission before returning a saved receipt", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  await createSong({ data });
  await f.prisma.member.deleteMany({ where: { organizationId: f.orgId, userId: f.userId } });
  await expect(createSong({ data })).rejects.toThrow("Forbidden");
});

it("rejects foreign songs and cue sections without touching either organization", async () => {
  const f = authenticated; const song = await existingSong(f); const other = await fixture();
  const foreign = await createSong({ data: other.input });
  const foreignSong = await getSong({ data: { orgId: other.orgId, songId: foreign.id } });
  await expect(saveSongMetadata({ data: { ...other.input, songId: song.id, title: "Wrong organization" } })).rejects.toThrow("Song not found");
  await expect(saveSongCueMap({ data: { orgId: other.orgId, songId: foreign.id, name: "Foreign section", ...format,
    cues: [{ sectionId: song.sections[0].id, triggerTc: "00:00:01:00" }] } })).rejects.toThrow("another song");
  expect(await getSong({ data: { orgId: other.orgId, songId: foreign.id } })).toEqual(foreignSong);
});

it("rolls back a prepared command if another writer changes a section before commit", async () => {
  const f = authenticated; const song = await existingSong(f); const requestId = crypto.randomUUID();
  await expect(runSongWrite({ orgId: f.orgId, actorId: f.userId, requestId, kind: "metadata", payload: { title: "Stale title" }, targetSongId: song.id }, z.object({ ok: z.literal(true) }), async () => {
    await f.prisma.songSection.update({ where: { id: song.sections[0].id }, data: { lyrics: "Concurrent lyrics" } });
    return { songId: song.id, result: { ok: true as const }, statements: [env.DB.prepare("UPDATE song SET title=? WHERE id=? AND orgId=?").bind("Stale title", song.id, f.orgId)] };
  })).rejects.toThrow("changed while");
  const current = await getSong({ data: { orgId: f.orgId, songId: song.id } });
  expect(current.title).toBe(song.title); expect(current.sections[0].lyrics).toBe("Concurrent lyrics");
  expect(await env.DB.prepare("SELECT requestId FROM song_write_receipt WHERE orgId=? AND requestId=?").bind(f.orgId, requestId).first()).toBeNull();
});

it("rejects a prepared section deletion if a new cue maps it before commit", async () => {
  const f = authenticated; const song = await existingSong(f); const section = song.sections[1];
  await expect(runSongWrite({ orgId: f.orgId, actorId: f.userId, requestId: crypto.randomUUID(), kind: "delete-section", payload: { sectionId: section.id }, targetSongId: song.id }, z.object({ ok: z.literal(true) }), async () => {
    await f.prisma.songCue.create({ data: { orgId: f.orgId, cueMapId: song.cueMaps[0].id, sectionId: section.id, triggerTc: "00:00:02:00", triggerFrame: 60, sortOrder: 1 } });
    return { songId: song.id, result: { ok: true as const }, statements: [env.DB.prepare("DELETE FROM song_section WHERE id=? AND orgId=?").bind(section.id, f.orgId)] };
  })).rejects.toThrow("changed while");
  expect(await f.prisma.songSection.findUnique({ where: { id: section.id } })).not.toBeNull();
  expect(await f.prisma.songCue.count({ where: { sectionId: section.id } })).toBe(1);
});
