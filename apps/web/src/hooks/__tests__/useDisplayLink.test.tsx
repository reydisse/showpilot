import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/display-access", () => ({ createDisplayLink: api.create }));
import { useDisplayLink } from "../useDisplayLink";
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("bounds creation, ignores a late link, and exposes a separate monitor URL after Retry", async () => {
  let finish: (link: { path: string; expiresAt: number }) => void = () => {};
  api.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementation(async () => ({ path: "/overlay/venue?displayPass=current", expiresAt: Date.now() + 60_000 }));
  const { result } = renderHook(() => useDisplayLink("venue", "overlay"));
  expect(result.current.pending).toBe(true); await tick(8_000);
  expect(api.create.mock.calls[0][0].signal.aborted).toBe(true);
  expect(result.current.pending).toBe(false); expect(result.current.errorAt).toBe(Date.now());
  await act(async () => { result.current.refresh(); });
  expect(result.current.url).toContain("displayPass=current");
  expect(result.current.url).not.toContain("monitor");
  expect(result.current.monitorUrl).toContain("monitor=1");
  await act(async () => { finish({ path: "/overlay/venue?displayPass=old", expiresAt: Date.now() + 60_000 }); });
  expect(result.current.url).not.toContain("displayPass=old");
});

it("retains a valid link after a failed refresh but prevents copying or opening it after expiry", async () => {
  api.create.mockResolvedValueOnce({ path: "/overlay/venue?displayPass=valid", expiresAt: Date.now() + 10_000 }).mockRejectedValue(new Error("Offline"));
  const { result } = renderHook(() => useDisplayLink("venue", "overlay")); await tick();
  await act(async () => { result.current.refresh(); });
  expect(result.current.url).toContain("valid"); expect(result.current.error).toContain("Could not create");
  await tick(10_000);
  expect(result.current.url).toBe(""); expect(result.current.monitorUrl).toBe("");
  expect(await result.current.copy()).toBe(false);
});

it("does not expose old workspace links or failures after scope changes", async () => {
  api.create.mockImplementation(async ({ data }) => ({ path: `/overlay/${data.orgSlug}?displayPass=fixture`, expiresAt: Date.now() + 60_000 }));
  const { result, rerender } = renderHook(({ slug }) => useDisplayLink(slug, "overlay"), { initialProps: { slug: "old" } });
  await tick(); expect(result.current.url).toContain("/old?");
  rerender({ slug: "new" });
  expect(result.current.url).toBe(""); expect(result.current.error).toBeNull();
  await tick(); expect(result.current.url).toContain("/new?");
});
