import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshRetainedResult } from "../retained-refresh";
type Result = { requestId: string; refresh: "failed" | "pending" | "done" };
let client: QueryClient;
const key = ["retained", "user", "org"];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const refresh = (work: () => Promise<void>) =>
  refreshRetainedResult<Result>({
    client,
    key,
    refresh: work,
    begin: (current) => {
      if (!current || current.refresh !== "failed") return null;
      return {
        pending: { ...current, refresh: "pending" },
        done: { ...current, refresh: "done" },
        failed: () => ({ ...current, refresh: "failed" }),
      };
    },
  });
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  client.setQueryData<Result>(key, {
    requestId: "original",
    refresh: "failed",
  });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});
it("claims a refresh synchronously so repeated clicks share one active attempt", async () => {
  const held = deferred<void>(),
    work = vi.fn(() => held.promise);
  const first = refresh(work),
    second = refresh(work);
  await Promise.resolve();
  expect(work).toHaveBeenCalledTimes(1);
  expect(await second).toBe(false);
  held.resolve();
  expect(await first).toBe(true);
  expect(client.getQueryData(key)).toEqual({
    requestId: "original",
    refresh: "done",
  });
});
it("cannot restore a removed account's result when its old refresh fails", async () => {
  const held = deferred<void>();
  const result = refresh(() => held.promise);
  await Promise.resolve();
  client.removeQueries({ queryKey: key, exact: true });
  held.reject(new Error("Old account refresh failed"));
  expect(await result).toBe(false);
  expect(client.getQueryData(key)).toBeUndefined();
});
it("cannot replace a newer command's result with an older refresh completion", async () => {
  const held = deferred<void>();
  const result = refresh(() => held.promise);
  await Promise.resolve();
  client.setQueryData<Result>(key, { requestId: "newer", refresh: "done" });
  held.resolve();
  expect(await result).toBe(false);
  expect(client.getQueryData(key)).toEqual({
    requestId: "newer",
    refresh: "done",
  });
});
it("releases the claim at its deadline without accepting a late success", async () => {
  const held = deferred<void>();
  const result = refresh(() => held.promise);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(await result).toBe(false);
  expect(client.getQueryData(key)).toEqual({
    requestId: "original",
    refresh: "failed",
  });
  held.resolve();
  await Promise.resolve();
  expect(client.getQueryData(key)).toEqual({
    requestId: "original",
    refresh: "failed",
  });
  expect(await refresh(async () => {})).toBe(true);
});
