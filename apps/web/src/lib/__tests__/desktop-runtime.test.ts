import { afterEach, describe, expect, it } from "vitest";
import {
  cacheDesktopService,
  getDesktopEngineInfo,
  isDesktopRuntime,
  openDesktopWindow,
} from "@/lib/desktop-runtime";

const originalTauri = window.__TAURI__;

afterEach(() => {
  window.__TAURI__ = originalTauri;
});

describe("desktop runtime boundary", () => {
  it("stays inert in a normal browser", async () => {
    window.__TAURI__ = undefined;
    expect(isDesktopRuntime()).toBe(false);
    await expect(getDesktopEngineInfo()).resolves.toBeNull();
    await expect(cacheDesktopService({ id: "show-1" })).resolves.toBeNull();
  });

  it("uses only the validated native commands", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push([command, args]);
      if (command === "engine_info") {
        return {
          native: true,
          platform: "macos",
          version: "0.1.0",
          cachePath: "/tmp/showpilot",
        } as T;
      }
      return "ok" as T;
    };
    window.__TAURI__ = { core: { invoke } };

    expect(isDesktopRuntime()).toBe(true);
    await expect(getDesktopEngineInfo()).resolves.toMatchObject({ native: true });
    await openDesktopWindow("timer", "faithfire-production");
    await cacheDesktopService({ id: "show-1" });

    expect(calls[1]).toEqual([
      "open_companion_window",
      { kind: "timer", orgSlug: "faithfire-production" },
    ]);
    expect(calls[2]).toEqual([
      "cache_service",
      { payload: JSON.stringify({ id: "show-1" }) },
    ]);
  });
});
