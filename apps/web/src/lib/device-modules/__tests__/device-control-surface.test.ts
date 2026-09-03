import { describe, expect, it } from "vitest";
import {
  parseBooleanArrayFeedback,
  parseNumberArrayFeedback,
  parseStringArrayFeedback,
  resolveDeviceControlSurface,
} from "@/lib/device-control-surface";

describe("device control surfaces", () => {
  it("chooses a surface from capabilities instead of adapter names", () => {
    expect(resolveDeviceControlSurface([{ id: "set_channel_fader" }, { id: "mute_channel" }], "mixer")).toBe("mixer");
    expect(resolveDeviceControlSurface([{ id: "set_program_input" }, { id: "set_preview_input" }], "video")).toBe("switcher");
    expect(resolveDeviceControlSurface([{ id: "power_on" }, { id: "power_off" }], "video")).toBe("display");
    expect(resolveDeviceControlSurface([{ id: "start_streaming" }, { id: "stop_streaming" }], "streaming")).toBe("streaming");
    expect(resolveDeviceControlSurface([{ id: "blackout" }, { id: "restore" }], "lighting")).toBe("lighting");
  });

  it("keeps automation and unknown adapters total", () => {
    expect(resolveDeviceControlSurface([], "automation")).toBe("automation");
    expect(resolveDeviceControlSurface([], "comms")).toBe("generic");
  });

  it("parses typed feedback arrays without trusting malformed values", () => {
    expect(parseNumberArrayFeedback("[0.25,null,\"bad\",0.75]")).toEqual([0.25, null, null, 0.75]);
    expect(parseBooleanArrayFeedback("[true,false,null,1]")).toEqual([true, false, null, null]);
    expect(parseStringArrayFeedback("[\"Cam 1\",null,\"Cam 2\"]")).toEqual(["Cam 1", "Cam 2"]);
    expect(parseNumberArrayFeedback("not json")).toEqual([]);
  });
});
