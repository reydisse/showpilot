import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowserErrorReporting } from "../browser-error-reporting";

const absorbFixtureError = (event: ErrorEvent) => event.preventDefault();
const cleanups: Array<() => void> = [];
beforeEach(() => { window.addEventListener("error", absorbFixtureError); vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 }))); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); window.removeEventListener("error", absorbFixtureError); vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const error = (filename = `${window.location.origin}/assets/rundown-fixture.js?token=secret#private`, lineno = 12) => window.dispatchEvent(new ErrorEvent("error", {
  cancelable: true, error: new TypeError("private lyric password=secret"), message: "private lyric password=secret", filename, lineno, colno: 8,
}));

it("reports safe source coordinates and a notice without messages, stacks, query strings or page URLs", async () => {
  const notice = vi.fn(); cleanups.push(installBrowserErrorReporting("org-1", notice)); error(); await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe("/api/operational-errors/org-1");
  expect(JSON.parse(String(init?.body))).toEqual({ code: "browser_error", errorName: "TypeError", asset: "rundown-fixture.js", line: 12, column: 8 });
  expect(JSON.stringify(init)).not.toMatch(/secret|private|password|token|stack/);
  expect(notice).toHaveBeenCalledWith({ occurredAt: expect.any(Number) });
});

it("omits external and arbitrary sources and treats rejection messages as private", async () => {
  cleanups.push(installBrowserErrorReporting("org-1", vi.fn()));
  error("https://external.test/private.js?token=secret");
  const rejection = new Event("unhandledrejection"); Object.defineProperty(rejection, "reason", { value: "secret rejection payload" });
  window.dispatchEvent(rejection); await flush();
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { code: "browser_error", errorName: "TypeError" }, { code: "browser_rejection", errorName: "Unknown" },
  ]);
});

it("deduplicates repeated failures, caps each minute and resumes after the window", async () => {
  cleanups.push(installBrowserErrorReporting("org-1", vi.fn()));
  error(); error(); for (let i = 1; i <= 10; i++) error(undefined, i); await flush();
  expect(fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(60_000); error(); await flush();
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("aborts slow reports, handles reporting failures and detaches on workspace exit", async () => {
  vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("offline")))));
  const cleanup = installBrowserErrorReporting("org-1", vi.fn()); cleanups.push(cleanup);
  error(); await flush(); const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(3000); expect(signal?.aborted).toBe(true);
  cleanup(); error(undefined, 15); await flush(); expect(fetch).toHaveBeenCalledTimes(1);
});
