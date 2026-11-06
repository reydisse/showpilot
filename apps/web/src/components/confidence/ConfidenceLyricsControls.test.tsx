import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfidenceLyricsControls } from "./ConfidenceLyricsControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const lyrics = { songId: "song", songTitle: "Song", sectionId: "verse", sectionLabel: "Verse", lyrics: "One\nTwo", nextLabel: "Chorus", updatedAt: 1, manual: true, revision: "r1" };

it("hides write controls from display-only visitors without requesting the timeline", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { render(<ConfidenceLyricsControls orgSlug="org" showId="show" lyrics={lyrics} connected />); });
  expect(screen.queryByRole("button")).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe("/api/timecode/org/lyrics-controls?showId=show");
});

it("requires the session's existing show control and preserves output while awaiting acknowledgement", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ canControl: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<ConfidenceLyricsControls orgSlug="org" showId="show" lyrics={lyrics} connected />);
  await screen.findByRole("button", { name: "Next section" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next section" })); });
  expect(fetcher.mock.calls[1][0]).toBe("/api/timecode/org/command?showId=show");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ action: "control-lyrics", payload: { operation: "next", expected: { revision: "r1" } } });
  view.rerender(<ConfidenceLyricsControls orgSlug="org" showId="show" lyrics={lyrics} connected={false} />);
  expect(screen.queryByRole("button", { name: "Next section" })).toBeNull();
});

it("keeps another member's controls disabled and points them to Timecode", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ canControl: false })));
  render(<ConfidenceLyricsControls orgSlug="org" showId="show" lyrics={lyrics} connected />);
  const next = await screen.findByRole("button", { name: "Next section" });
  expect(next).toHaveProperty("disabled", true);
  expect(screen.getByRole("link", { name: "Timecode" })).toHaveProperty("pathname", "/org/timecode");
});
