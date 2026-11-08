import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  env: {
    BETTER_AUTH_SECRET: "fixture-only",
    RUNDOWN_RELAY: { getByName: () => ({ fetch: mocks.fetch }) },
    TIMECODE_RELAY: { getByName: () => ({ fetch: mocks.fetch }) },
  },
}));
import { showDeletionRelays } from "../show-deletion-relays.server";
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const target = {
  orgId: "org",
  showId: "show",
  serviceDate: "2026-11-08",
  nonce: "deletion",
};

it("bounds a transport that ignores abort and cancels its eventual reply", async () => {
  vi.useFakeTimers();
  let complete: ((response: Response) => void) | undefined;
  mocks.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const deleting = showDeletionRelays.prepare(target);
  const result = expect(deleting).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(mocks.fetch.mock.calls[0][0].signal.aborted).toBe(true);
  const cancel = vi.fn();
  complete?.(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it("keeps a relay refusal distinct from a recoverable cleanup outage", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response("Running", { status: 409 }));
  await expect(showDeletionRelays.prepare(target)).rejects.toThrow(
    "Stop the show",
  );
  mocks.fetch.mockResolvedValueOnce(
    new Response("Unavailable", { status: 503 }),
  );
  await expect(showDeletionRelays.purge(target)).rejects.toThrow(
    "Retry deletion",
  );
});
