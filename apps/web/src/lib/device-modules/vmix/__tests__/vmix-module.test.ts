import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VMixModule, vmixModuleDefinition } from "../vmix-module";
import type { DeviceConnectionStatus } from "../../types";

// ─── Mock fetch ───────────────────────────────────────────

const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy;

function mockFetchSuccess(xml = "<vmix></vmix>") {
  fetchSpy.mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(xml),
  });
}

function mockFetchFailure() {
  fetchSpy.mockRejectedValue(new Error("Network error"));
}

describe("VMixModule", () => {
  let module: VMixModule;

  beforeEach(() => {
    fetchSpy.mockReset();
    module = new VMixModule({ host: "192.168.1.200", port: 8088 });
  });

  afterEach(() => {
    module.disconnect();
  });

  describe("connection", () => {
    it("connects by fetching vMix API", async () => {
      mockFetchSuccess();
      await module.connect();
      expect(module.connectionStatus()).toBe("connected");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://192.168.1.200:8088/api/"
      );
    });

    it("transitions to error if fetch fails", async () => {
      mockFetchFailure();
      await module.connect();
      expect(module.connectionStatus()).toBe("error");
    });

    it("uses default port 8088", () => {
      const m = new VMixModule({ host: "10.0.0.1" });
      expect(m).toBeDefined();
    });

    it("notifies status listeners", async () => {
      mockFetchSuccess();
      const statuses: DeviceConnectionStatus[] = [];
      module.onStatusChange((s) => statuses.push(s));
      await module.connect();
      expect(statuses).toEqual(["connecting", "connected"]);
    });
  });

  describe("actions", () => {
    it("returns vMix actions", () => {
      const actions = module.getActions();
      const ids = actions.map((a) => a.id);
      expect(ids).toContain("cut");
      expect(ids).toContain("fade");
      expect(ids).toContain("set_program_input");
      expect(ids).toContain("set_preview_input");
      expect(ids).toContain("start_streaming");
      expect(ids).toContain("stop_streaming");
    });

    it("sends correct HTTP request for cut", async () => {
      mockFetchSuccess();
      await module.connect();
      fetchSpy.mockClear();
      mockFetchSuccess();

      await module.executeAction("cut", {});
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://192.168.1.200:8088/api/?Function=Cut"
      );
    });

    it("sends correct HTTP request for set_program_input", async () => {
      mockFetchSuccess();
      await module.connect();
      fetchSpy.mockClear();
      mockFetchSuccess();

      await module.executeAction("set_program_input", { input: "2" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://192.168.1.200:8088/api/?Function=ActiveInput&Input=2"
      );
    });

    it("throws when not connected", async () => {
      await expect(module.executeAction("cut", {})).rejects.toThrow(
        "Not connected"
      );
    });
  });

  describe("feedbacks", () => {
    it("returns feedback definitions", () => {
      const feedbacks = module.getFeedbacks();
      const ids = feedbacks.map((f) => f.id);
      expect(ids).toContain("active_input");
      expect(ids).toContain("preview_input");
      expect(ids).toContain("streaming_active");
      expect(ids).toContain("recording_active");
    });
  });

  describe("module definition", () => {
    it("has correct metadata", () => {
      expect(vmixModuleDefinition.adapterType).toBe("vmix");
      expect(vmixModuleDefinition.category).toBe("video");
      expect(vmixModuleDefinition.connectivity).toBe("browser-direct");
      expect(vmixModuleDefinition.transport).toBe("http");
    });
  });
});
