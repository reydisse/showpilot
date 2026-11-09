import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCrewCsvFile } from "../csv-file";
import { MAX_CSV_BYTES } from "../csv-import-contract";

class Reader {
  static LOADING = 1;
  static latest: Reader;
  readyState = 0;
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    Reader.latest = this;
  }
  readAsText = vi.fn(() => {
    this.readyState = 1;
  });
  abort = vi.fn(() => {
    this.readyState = 2;
    this.onabort?.();
  });
}
const file = () =>
  new File(["name,email\nJane,jane@import.invalid"], "crew.csv");
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("FileReader", Reader);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("resolves only a successful file read and releases its timer and listeners", async () => {
  const controller = new AbortController();
  const pending = readCrewCsvFile(file(), controller.signal);
  Reader.latest.result = "name,email\nJane,jane@import.invalid";
  Reader.latest.readyState = 2;
  Reader.latest.onload?.();
  expect(await pending).toContain("Jane");
  controller.abort();
  expect(Reader.latest.abort).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("reports errors and ignores a late load after the eight-second deadline", async () => {
  const pending = readCrewCsvFile(file(), new AbortController().signal);
  const lateLoad = Reader.latest.onload;
  const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(8000);
  await rejected;
  Reader.latest.result = "late CSV";
  lateLoad?.();
  expect(Reader.latest.abort).toHaveBeenCalledOnce();
  expect(Reader.latest.onload).toBeNull();
  const failed = readCrewCsvFile(file(), new AbortController().signal);
  Reader.latest.onerror?.();
  await expect(failed).rejects.toThrow("previous CSV is unchanged");
});
it("cancels active and already-aborted reads without accepting their result", async () => {
  const controller = new AbortController();
  const pending = readCrewCsvFile(file(), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(Reader.latest.abort).toHaveBeenCalledOnce();
  await expect(readCrewCsvFile(file(), controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(Reader.latest.readAsText).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects oversized files before reading and invalid decoded contents", async () => {
  await expect(
    readCrewCsvFile(
      new File(["x".repeat(MAX_CSV_BYTES + 1)], "large.csv"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("512 KB");
  const pending = readCrewCsvFile(file(), new AbortController().signal);
  Reader.latest.result = "";
  Reader.latest.onload?.();
  await expect(pending).rejects.toThrow("empty");
});
