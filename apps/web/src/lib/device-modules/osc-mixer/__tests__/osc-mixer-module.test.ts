import { describe, expect, it } from "vitest";
import { buildMixerOscCommand, mixerActionsFor, parseOscMixerState } from "../osc-mixer-module";

describe("mixer OSC commands", () => {
  it("encodes X32 fader and mute semantics", () => {
    expect(buildMixerOscCommand("x32", "set_channel_fader", { channel: 3, level: 0.75 }))
      .toBe("/ch/03/mix/fader f:0.75");
    expect(buildMixerOscCommand("x32", "mute_channel", { channel: 3, muted: true }))
      .toBe("/ch/03/mix/on i:0");
    expect(buildMixerOscCommand("x32", "mute_channel", { channel: 3, muted: false }))
      .toBe("/ch/03/mix/on i:1");
  });

  it("encodes X32 buses, DCAs, scenes, and snippets", () => {
    expect(buildMixerOscCommand("x32", "set_bus_send", { channel: 12, bus: 2, level: 0.4 }))
      .toBe("/ch/12/mix/02/level f:0.4");
    expect(buildMixerOscCommand("x32", "set_dca_fader", { dca: 2, level: 0.5 }))
      .toBe("/dca/2/fader f:0.5");
    expect(buildMixerOscCommand("x32", "recall_scene", { scene: 1 }))
      .toBe("/-action/goscene i:0");
    expect(buildMixerOscCommand("x32", "recall_snippet", { snippet: 8 }))
      .toBe("/-action/gosnippet i:7");
  });

  it("uses WING's verified core OSC paths and port-independent address format", () => {
    expect(buildMixerOscCommand("wing", "set_channel_fader", { channel: 40, level: 1 }))
      .toBe("/ch/40/fdr f:1");
    expect(buildMixerOscCommand("wing", "mute_channel", { channel: 1, muted: true }))
      .toBe("/ch/1/mute i:1");
    expect(buildMixerOscCommand("wing", "mute_dca", { dca: 8, muted: false }))
      .toBe("/dca/8/mute i:0");
  });

  it("rejects invalid values and unverified WING operations", () => {
    expect(() => buildMixerOscCommand("x32", "set_channel_fader", { channel: 0, level: 0.5 }))
      .toThrow("Invalid channel");
    expect(() => buildMixerOscCommand("x32", "set_channel_fader", { channel: 1, level: 1.1 }))
      .toThrow("Level must be between 0 and 1");
    expect(() => buildMixerOscCommand("wing", "recall_scene", { scene: 1 }))
      .toThrow("not available through the WING OSC fallback");
    expect(() => buildMixerOscCommand("x32", "mute_channel", { channel: 1, muted: "false" }))
      .toThrow("Muted must be on or off");
  });

  it("advertises the channel range each console can execute", () => {
    const channelMaximum = (consoleType: "x32" | "wing") => mixerActionsFor(consoleType)
      .find((action) => action.id === "set_channel_fader")
      ?.params.find((param) => param.id === "channel")?.max;
    expect(channelMaximum("x32")).toBe(32);
    expect(channelMaximum("wing")).toBe(40);
  });

  it("maps Bridge mixer snapshots into module feedback ids", () => {
    expect(parseOscMixerState(JSON.stringify({
      channelFader: [0.5, null],
      channelMute: [false, true],
      dcaFader: [0.75],
      dcaMute: [false],
    }))).toEqual({
      channel_fader: "[0.5,null]",
      channel_mute: "[false,true]",
      dca_fader: "[0.75]",
      dca_mute: "[false]",
    });
  });
});
