import { afterEach, expect, it, vi } from "vitest";
import { readCrewPhoto } from "../crew-roster-photo";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("reads a real browser File and rejects oversized photos before reading", async () => {
  const signal = new AbortController().signal;
  expect(
    await readCrewPhoto(
      new File(["photo"], "photo.png", { type: "image/png" }),
      signal,
    ),
  ).toBe("data:image/png;base64,cGhvdG8=");
  await expect(
    readCrewPhoto(new File([new Uint8Array(1_500_001)], "large.png"), signal),
  ).rejects.toThrow("1.5 MB");
});
it("settles a stuck reader at its deadline and aborts underlying work", async () => {
  vi.useFakeTimers();
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
  const abort = vi.spyOn(FileReader.prototype, "abort");
  const result = expect(
    readCrewPhoto(
      new File(["photo"], "photo.png"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(abort).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels preparation when the editor closes without leaving a timer", async () => {
  vi.useFakeTimers();
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
  const controller = new AbortController();
  const result = expect(
    readCrewPhoto(new File(["photo"], "photo.png"), controller.signal),
  ).rejects.toThrow("cancelled");
  controller.abort();
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
