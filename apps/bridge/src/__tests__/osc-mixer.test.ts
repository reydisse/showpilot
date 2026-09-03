import { describe, expect, it } from "vitest";
import {
  applyOscMixerMessage,
  createOscMixerState,
  mixerQueryAddresses,
  oscMixerEventPayload,
} from "../protocols/osc-mixer.js";

describe("OSC mixer state", () => {
  it("maps X32 faders and inverse on-state to mute feedback", () => {
    const state = createOscMixerState("x32");
    expect(applyOscMixerMessage(state, "x32", { address: "/ch/01/mix/fader", args: [{ type: "f", value: 0.75 }] })).toBe(true);
    expect(applyOscMixerMessage(state, "x32", { address: "/ch/01/mix/on", args: [{ type: "i", value: 0 }] })).toBe(true);
    expect(state.channelFader[0]).toBeCloseTo(0.75);
    expect(state.channelMute[0]).toBe(true);
  });

  it("maps WING mute semantics directly", () => {
    const state = createOscMixerState("wing");
    applyOscMixerMessage(state, "wing", { address: "/ch/40/fdr", args: [{ type: "f", value: 0.3 }] });
    applyOscMixerMessage(state, "wing", { address: "/ch/40/mute", args: [{ type: "i", value: 1 }] });
    expect(state.channelFader[39]).toBeCloseTo(0.3);
    expect(state.channelMute[39]).toBe(true);
  });

  it("builds the complete query catalog and serializable event payload", () => {
    expect(mixerQueryAddresses("x32")).toHaveLength(80);
    expect(mixerQueryAddresses("wing")).toHaveLength(96);
    expect(JSON.parse(oscMixerEventPayload(createOscMixerState("x32"))).channelFader).toHaveLength(32);
  });
});
