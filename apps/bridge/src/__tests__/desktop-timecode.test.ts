import { expect, it } from "vitest";
import { parseDesktopTimecode } from "../desktop-timecode";

it("parses only the native MIDI transport states", () => {
  for (const state of ["stopped", "waiting"]) expect(parseDesktopTimecode({ type: "timecode-transport", state })).toEqual({ type: "timecode-transport", state });
  for (const state of ["running", null, {}, false]) expect(parseDesktopTimecode({ type: "timecode-transport", state })).toBeNull();
});
it("checks native timecode labels and strips unrelated fields", () => {
  const feed = { type: "timecode-feed", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 1 }, format: { frameRate: 30, dropFrame: "ndf" }, totalFrames: 1 };
  expect(parseDesktopTimecode({ ...feed, extra: "discard" })).toEqual(feed);
  expect(parseDesktopTimecode({ ...feed, totalFrames: Infinity })).toBeNull();
  expect(parseDesktopTimecode({ ...feed, timecode: { ...feed.timecode, frames: 30 } })).toBeNull();
  expect(parseDesktopTimecode({ ...feed, format: { frameRate: 30, dropFrame: "df" } })).toBeNull();
  expect(parseDesktopTimecode({ ...feed, timecode: { ...feed.timecode, minutes: 1, frames: 0 }, format: { frameRate: 29.97, dropFrame: "df" } })).toBeNull();
});
