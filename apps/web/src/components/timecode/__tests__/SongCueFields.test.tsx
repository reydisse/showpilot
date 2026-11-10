import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SongCueFields, type CueSong } from "../SongCueFields";
import type { CueDetails } from "@/lib/automation-catalog";
vi.mock("@/lib/songs", () => ({ getSong: vi.fn(), listSongs: vi.fn() }));
afterEach(cleanup);
const song: CueSong = { id: "song", title: "Saved song", ppPresentationUuid: "presentation", sections: [
  { id: "verse", songId: "song", orgId: "org", label: "Verse", lyrics: "First line\nSecond line", sourceSlideIndex: 0, sourceSlideId: "", sortOrder: 0 },
  { id: "chorus", songId: "song", orgId: "org", label: "Chorus", lyrics: "Chorus words", sourceSlideIndex: 3, sourceSlideId: "", sortOrder: 1 },
] };

it.each([false, true])("builds a complete saved section payload with ProPresenter=%s", async proPresenter => {
  const change = vi.fn<(details: CueDetails) => void>();
  render(<SongCueFields proPresenter={proPresenter} initial={{}} onChange={change} loadSongs={async () => [song]} loadSong={async () => song} />);
  await screen.findByRole("option", { name: "Saved song" });
  fireEvent.change(screen.getByLabelText(proPresenter ? "ProPresenter song" : "Song"), { target: { value: "song" } });
  await screen.findByRole("option", { name: "Verse" });
  fireEvent.change(screen.getByLabelText("Section"), { target: { value: "verse" } });
  expect(change.mock.lastCall?.[0]).toEqual({ status: "ready", payload: proPresenter ? { presentationUuid: "presentation", slideIndex: 0 } : { songId: "song", songTitle: "Saved song", sectionId: "verse", sectionLabel: "Verse", lyrics: "First line\nSecond line", nextLabel: "Chorus" } });
  expect(screen.getByText("First line Second line")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Section"), { target: { value: "" } });
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
});

it("does not reuse an old song's section response or missing ProPresenter mapping", async () => {
  let complete: (value: CueSong) => void = () => {};
  const change = vi.fn<(details: CueDetails) => void>();
  const second: CueSong = { ...song, id: "second", title: "Second song", sections: [{ ...song.sections[0], id: "unmapped", songId: "second", sourceSlideIndex: null }] };
  render(<SongCueFields proPresenter initial={{}} onChange={change} loadSongs={async () => [song, second]} loadSong={id => id === "song" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(second)} />);
  await screen.findByRole("option", { name: "Saved song" });
  fireEvent.change(screen.getByLabelText("ProPresenter song"), { target: { value: "song" } });
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("ProPresenter song"), { target: { value: "second" } });
  await screen.findByRole("option", { name: "Verse" });
  await act(async () => complete(song));
  fireEvent.change(screen.getByLabelText("Section"), { target: { value: "unmapped" } });
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
  expect(screen.getByRole("alert").textContent).toContain("no ProPresenter slide");
  expect(screen.queryByRole("option", { name: "Chorus" })).toBeNull();
});
