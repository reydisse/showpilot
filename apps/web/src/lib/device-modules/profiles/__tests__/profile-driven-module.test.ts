import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProfileDrivenModule } from "../profile-driven-module";
import type { DeviceProfile } from "../types";
import type { ProtocolDriver } from "../../protocols/protocol-driver";

// ─── Mock Protocol Driver ─────────────────────────────────

function createMockDriver(overrides?: Partial<ProtocolDriver>): ProtocolDriver {
  return {
    protocolId: "test",
    transport: "http",
    connectivity: "browser-direct",
    baseConfigFields: [],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue("OK"),
    onEvent: vi.fn().mockReturnValue(() => {}),
    isConnected: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

// ─── Test Profile ─────────────────────────────────────────

const testProfile: DeviceProfile = {
  profileVersion: 1,
  id: "test-device",
  manufacturer: "Test",
  model: "Device 1",
  category: "video",
  icon: "Monitor",
  description: "Test device",
  protocol: "test",
  actions: [
    {
      id: "power_on",
      label: "Power On",
      category: "power",
      params: [],
      mapping: { command: "POWER ON\r" },
    },
    {
      id: "set_input",
      label: "Set Input",
      category: "input",
      params: [
        {
          id: "input",
          label: "Input",
          type: "select",
          options: [
            { value: "hdmi1", label: "HDMI 1" },
            { value: "hdmi2", label: "HDMI 2" },
          ],
        },
      ],
      mapping: {
        command: "INPUT {{input}}\r",
        paramTransforms: {
          input: {
            type: "map",
            values: { hdmi1: "31", hdmi2: "32" },
          },
        },
      },
    },
    {
      id: "set_volume",
      label: "Set Volume",
      category: "audio",
      params: [
        { id: "level", label: "Level", type: "number", min: 0, max: 1, step: 0.01 },
      ],
      mapping: {
        command: "VOL {{level}}\r",
        paramTransforms: {
          level: { type: "scale", factor: 255 },
        },
      },
    },
  ],
  feedbacks: [
    {
      id: "power_status",
      label: "Power Status",
      type: "enum",
      defaultValue: "unknown",
      mapping: {
        pollCommand: "POWER?\r",
        pollInterval: 5000,
        responsePattern: "POWER=(\\w+)",
        captureGroup: 1,
        valueMap: { ON: "on", OFF: "off", WARMING: "warming" },
      },
    },
    {
      id: "current_input",
      label: "Current Input",
      type: "string",
      defaultValue: "",
      mapping: {
        pollCommand: "INPUT?\r",
        pollInterval: 10000,
        responsePattern: "INPUT=(\\d+)",
        captureGroup: 1,
      },
    },
  ],
  quirks: {
    commandInterval: 100,
  },
};

// ─── Tests ────────────────────────────────────────────────

describe("ProfileDrivenModule", () => {
  let driver: ProtocolDriver;
  let module: ProfileDrivenModule;

  beforeEach(() => {
    vi.useFakeTimers();
    driver = createMockDriver();
    module = new ProfileDrivenModule(testProfile, driver, {});
  });

  afterEach(() => {
    module.disconnect();
    vi.useRealTimers();
  });

  // ─── Connection ─────────────────────────────────────────

  describe("connection", () => {
    it("delegates connect to protocol driver", async () => {
      await module.connect();
      expect(driver.connect).toHaveBeenCalled();
      expect(module.connectionStatus()).toBe("connected");
    });

    it("transitions to error if driver connect fails", async () => {
      driver = createMockDriver({
        connect: vi.fn().mockRejectedValue(new Error("refused")),
      });
      module = new ProfileDrivenModule(testProfile, driver, {});

      await module.connect();
      expect(module.connectionStatus()).toBe("error");
    });

    it("delegates disconnect to protocol driver", async () => {
      await module.connect();
      module.disconnect();
      expect(driver.disconnect).toHaveBeenCalled();
      expect(module.connectionStatus()).toBe("disconnected");
    });

    it("applies connectDelay quirk", async () => {
      const profileWithDelay = {
        ...testProfile,
        quirks: { connectDelay: 500 },
      };
      driver = createMockDriver();
      module = new ProfileDrivenModule(profileWithDelay, driver, {});

      const connectPromise = module.connect();
      expect(module.connectionStatus()).toBe("connecting");

      await vi.advanceTimersByTimeAsync(500);
      await connectPromise;

      expect(module.connectionStatus()).toBe("connected");
    });
  });

  // ─── Actions ────────────────────────────────────────────

  describe("actions", () => {
    it("returns actions from profile", () => {
      const actions = module.getActions();
      expect(actions).toHaveLength(3);
      expect(actions.map((a) => a.id)).toEqual([
        "power_on",
        "set_input",
        "set_volume",
      ]);
    });

    it("preserves action params from profile", () => {
      const actions = module.getActions();
      const setInput = actions.find((a) => a.id === "set_input")!;
      expect(setInput.params).toHaveLength(1);
      expect(setInput.params[0].type).toBe("select");
    });
  });

  // ─── Command Interpolation ──────────────────────────────

  describe("command interpolation", () => {
    beforeEach(async () => {
      await module.connect();
    });

    it("sends raw command for paramless actions", async () => {
      await module.executeAction("power_on", {});
      vi.advanceTimersByTime(100);
      expect(driver.sendCommand).toHaveBeenCalledWith("POWER ON\r");
    });

    it("interpolates {{param}} in command template", async () => {
      // With no transform defined for a param, raw value is used
      const profile2: DeviceProfile = {
        ...testProfile,
        actions: [
          {
            id: "raw_cmd",
            label: "Raw",
            params: [{ id: "value", label: "V", type: "string" }],
            mapping: { command: "CMD {{value}}\r" },
          },
        ],
        };
      module = new ProfileDrivenModule(profile2, driver, {});
      await module.connect();

      await module.executeAction("raw_cmd", { value: "hello" });
      vi.advanceTimersByTime(100);
      expect(driver.sendCommand).toHaveBeenCalledWith("CMD hello\r");
    });

    it("applies map transform", async () => {
      await module.executeAction("set_input", { input: "hdmi1" });
      vi.advanceTimersByTime(100);
      expect(driver.sendCommand).toHaveBeenCalledWith("INPUT 31\r");
    });

    it("applies map transform for hdmi2", async () => {
      await module.executeAction("set_input", { input: "hdmi2" });
      vi.advanceTimersByTime(100);
      expect(driver.sendCommand).toHaveBeenCalledWith("INPUT 32\r");
    });

    it("applies scale transform", async () => {
      await module.executeAction("set_volume", { level: 0.5 });
      vi.advanceTimersByTime(100);
      expect(driver.sendCommand).toHaveBeenCalledWith("VOL 127.5\r");
    });

    it("throws for unknown action", async () => {
      await expect(
        module.executeAction("nonexistent", {})
      ).rejects.toThrow("Unknown action");
    });

    it("throws when not connected", async () => {
      module.disconnect();
      await expect(
        module.executeAction("power_on", {})
      ).rejects.toThrow("Not connected");
    });
  });

  // ─── Command Queue ──────────────────────────────────────

  describe("command queue", () => {
    beforeEach(async () => {
      await module.connect();
    });

    it("spaces commands by quirks.commandInterval", async () => {
      // Fire 3 commands rapidly
      module.executeAction("power_on", {});
      module.executeAction("power_on", {});
      module.executeAction("power_on", {});

      // First fires immediately (after microtask)
      await vi.advanceTimersByTimeAsync(0);
      expect(driver.sendCommand).toHaveBeenCalledTimes(1);

      // Second fires after commandInterval
      await vi.advanceTimersByTimeAsync(100);
      expect(driver.sendCommand).toHaveBeenCalledTimes(2);

      // Third fires after another interval
      await vi.advanceTimersByTimeAsync(100);
      expect(driver.sendCommand).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Feedbacks ──────────────────────────────────────────

  describe("feedbacks", () => {
    it("returns feedbacks from profile with default values", () => {
      const feedbacks = module.getFeedbacks();
      expect(feedbacks).toHaveLength(2);
      expect(feedbacks[0].id).toBe("power_status");
      expect(feedbacks[0].value).toBe("unknown");
    });

    it("starts polling after connect", async () => {
      await module.connect();

      // power_status polls at 5000ms, current_input at 10000ms
      vi.advanceTimersByTime(5000);
      expect(driver.sendCommand).toHaveBeenCalledWith("POWER?\r");
    });

    it("parses poll response with regex and valueMap", async () => {
      (driver.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue("POWER=ON");

      const changes: [string, unknown][] = [];
      module.onFeedbackChange((id, val) => changes.push([id, val]));

      await module.connect();
      vi.advanceTimersByTime(5000);

      // Wait for the poll response to process
      await vi.advanceTimersByTimeAsync(10);

      expect(changes).toContainEqual(["power_status", "on"]);
    });

    it("parses poll response with regex without valueMap", async () => {
      (driver.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue("INPUT=31");

      const changes: [string, unknown][] = [];
      module.onFeedbackChange((id, val) => changes.push([id, val]));

      await module.connect();
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(10);

      expect(changes).toContainEqual(["current_input", "31"]);
    });

    it("stops polling on disconnect", async () => {
      await module.connect();
      module.disconnect();

      (driver.sendCommand as ReturnType<typeof vi.fn>).mockClear();
      vi.advanceTimersByTime(15000);

      expect(driver.sendCommand).not.toHaveBeenCalledWith("POWER?\r");
    });
  });
});
