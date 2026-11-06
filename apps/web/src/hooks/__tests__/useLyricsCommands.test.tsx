import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLyricsCommands } from "../useLyricsCommands";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { orgId: "org", showId: "show", connected: true, canControl: true,
  lyrics: { songId: "song", songTitle: "Song", sectionId: "verse", sectionLabel: "Verse", lyrics: "One\nTwo", nextLabel: "Chorus", updatedAt: 1, manual: true, revision: "r1" } };

it("sends the reviewed slide and prevents a second request until acknowledgement", async () => {
  let resolve: (value: Response) => void = () => {};
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useLyricsCommands(options));
  let first: Promise<void> = Promise.resolve();
  act(() => { first = result.current.run("next"); });
  expect(result.current.pending).toBe("next");
  await expect(result.current.run("next")).rejects.toThrow("Wait for the current");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("/api/timecode/org/command?showId=show", expect.objectContaining({
    body: JSON.stringify({ action: "control-lyrics", payload: { operation: "next", expected: { songId: "song", sectionId: "verse", updatedAt: 1, revision: "r1", generationKey: null } } }),
  }));
  await act(async () => { resolve(Response.json({ ok: true })); await first; });
  expect(result.current.pending).toBeNull();
});

it("shows a rejected change and permits review and retry without clearing lyrics", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "Lyrics changed. Review the current section." }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useLyricsCommands(options));
  await act(async () => { await expect(result.current.run("clear")).rejects.toThrow("Lyrics changed"); });
  expect(result.current.error).toContain("Lyrics changed");
  expect(options.lyrics.lyrics).toBe("One\nTwo");
  await act(async () => { await result.current.run("clear"); });
  expect(result.current.error).toBeNull();
});

it("aborts an old show's request and ignores its late completion", async () => {
  let resolve: (value: Response) => void = () => {};
  const fetcher = vi.fn((_url: string, _request: RequestInit) => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ showId }) => useLyricsCommands({ ...options, showId }), { initialProps: { showId: "show" } });
  let first: Promise<void> = Promise.resolve();
  act(() => { first = result.current.run("next"); });
  const signal = fetcher.mock.calls[0][1].signal;
  rerender({ showId: "other-show" });
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(Response.json({ error: "Old show rejected" }, { status: 400 })); await expect(first).rejects.toThrow("Old show rejected"); });
  expect(result.current.error).toBeNull();
  expect(result.current.pending).toBeNull();
});

it.each([{ connected: false, canControl: true }, { connected: true, canControl: false }])("never sends without connection and control: %j", async access => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useLyricsCommands({ ...options, ...access }));
  await expect(result.current.run("next")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("reports an uncertain network failure without automatically replaying the action", async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useLyricsCommands(options));
  await act(async () => { await expect(result.current.run("next")).rejects.toThrow("Check the display and connection"); });
  expect(result.current.error).toContain("not confirmed");
  expect(result.current.pending).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});
