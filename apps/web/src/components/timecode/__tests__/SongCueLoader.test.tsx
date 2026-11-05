import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SongCueLoader } from "../SongCueLoader";

const songs = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/songs", () => ({ listSongs: songs.list, getSong: songs.get }));
const song = {
  id: "song-1", title: "Welcome", artist: "", ppPresentationUuid: "",
  cueMaps: [{ id: "map-1", name: "Default", format: JSON.stringify({ frameRate: 30, dropFrame: "ndf" }), cues: [
    { id: "cue-1", triggerFrame: 30, section: { id: "verse", label: "Verse", lyrics: "Welcome" }, ppSlideIndex: null },
  ] }],
};
const format = { frameRate: 30, dropFrame: "ndf" } as const;
beforeEach(() => { songs.list.mockResolvedValue([song]); songs.get.mockResolvedValue(song); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function select() {
  await screen.findByRole("option", { name: "Welcome" });
  fireEvent.change(screen.getByLabelText("Song"), { target: { value: "song-1" } });
  await screen.findByRole("option", { name: "Default · 1 cues" });
}

it("waits for relay confirmation before closing and blocks negative offsets", async () => {
  let confirm: () => void = () => {};
  const load = vi.fn(() => new Promise<void>((resolve) => { confirm = resolve; }));
  const close = vi.fn();
  render(<SongCueLoader orgId="test-org" format={format} defaultTarget="native" connected running={false} onLoad={load} onClose={close} />);
  await select();
  fireEvent.change(screen.getByLabelText("Offset frames"), { target: { value: "-30" } });
  expect(screen.getByRole("alert").textContent).toContain("zero or greater");
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  expect(load).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Offset frames"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  expect(load).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  await act(async () => confirm());
  expect(close).toHaveBeenCalledTimes(1);
});

it("keeps the selection after a failed save and disables loads when the clock starts or disconnects", async () => {
  const load = vi.fn(async () => { throw new Error("Relay did not confirm"); });
  const close = vi.fn();
  const props = { orgId: "test-org", format, defaultTarget: "native" as const, onLoad: load, onClose: close };
  const { rerender } = render(<SongCueLoader {...props} connected running={false} />);
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  await screen.findByText("Relay did not confirm");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Song")).toHaveProperty("value", "song-1");
  rerender(<SongCueLoader {...props} connected running />);
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  expect(screen.getByRole("status").textContent).toContain("Stop the clock");
  rerender(<SongCueLoader {...props} connected={false} running={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  expect(screen.getByRole("status").textContent).toContain("Reconnect");
  expect(load).toHaveBeenCalledTimes(1);
});

it.each(["not-json", JSON.stringify({ frameRate: 25, dropFrame: "ndf" })])("blocks an invalid or mismatched cue-map format: %s", async (stored) => {
  songs.get.mockResolvedValue({ ...song, cueMaps: [{ ...song.cueMaps[0], format: stored }] });
  const load = vi.fn(async () => {});
  render(<SongCueLoader orgId="test-org" format={format} defaultTarget="native" connected running={false} onLoad={load} onClose={() => {}} />);
  await select();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/invalid frame rate|does not match/));
  fireEvent.click(screen.getByRole("button", { name: "Load 1 mapped cues" }));
  expect(load).not.toHaveBeenCalled();
});
