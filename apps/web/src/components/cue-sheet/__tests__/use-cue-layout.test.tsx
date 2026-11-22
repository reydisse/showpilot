import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCueLayout } from "../use-cue-layout";

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("restores personal layout on this device without sharing another user's preferences", () => {
  const { result, rerender, unmount } = renderHook(({ orgId, userId }) => useCueLayout(orgId, userId), { initialProps: { orgId: "demo", userId: "lighting-user" } });
  act(() => result.current.update(layout => ({ ...layout, focus: "lx", collapsed: ["sound"], hidden: ["owner", "note"] })));
  rerender({ orgId: "demo", userId: "sound-user" });
  expect(result.current.layout.focus).toBeNull();
  rerender({ orgId: "other-demo-fixture", userId: "lighting-user" });
  expect(result.current.layout.focus).toBeNull();
  rerender({ orgId: "demo", userId: "lighting-user" });
  expect(result.current.layout).toMatchObject({ focus: "lx", collapsed: ["sound"], hidden: ["owner", "note"] });
  unmount();
  const restored = renderHook(() => useCueLayout("demo", "lighting-user"));
  expect(restored.result.current.layout.focus).toBe("lx");
});

it("ignores obsolete personal widths and remains usable when device storage is corrupt or unavailable", () => {
  localStorage.setItem("showpilot:cue-layout:v1:demo:user", JSON.stringify({ hidden: ["note", 42], collapsed: null, widths: { lx: 9000, sound: -10, bad: "wide" } }));
  const { result, unmount } = renderHook(() => useCueLayout("demo", "user"));
  expect(result.current.layout).not.toHaveProperty("widths"); expect(result.current.layout.hidden).toEqual(["note"]);
  unmount();
  localStorage.setItem("showpilot:cue-layout:v1:demo:user", "not json");
  const corrupt = renderHook(() => useCueLayout("demo", "user"));
  expect(corrupt.result.current.layout.hidden).toEqual(["owner"]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  act(() => corrupt.result.current.update(layout => ({ ...layout, focus: "lx" })));
  expect(corrupt.result.current.layout.focus).toBe("lx");
});
