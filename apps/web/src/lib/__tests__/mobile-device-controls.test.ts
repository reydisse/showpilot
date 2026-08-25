import { describe, expect, it } from "vitest";
import { actionsForMobileAdapter, buildMobileAtemCommand } from "../mobile-device-controls";

describe("mobile device control contracts", () => {
  it("only exposes actions supported by each trusted adapter", () => {
    expect(actionsForMobileAdapter("atem").map((action) => action.id)).toContain("cut");
    expect(actionsForMobileAdapter("osc-mixer", "x32").map((action) => action.id)).toContain("recall_scene");
    expect(actionsForMobileAdapter("osc-mixer", "wing").map((action) => action.id)).not.toContain("recall_scene");
    expect(actionsForMobileAdapter("unknown")).toEqual([]);
  });

  it("builds allowlisted ATEM commands with normalized parameters", () => {
    expect(JSON.parse(buildMobileAtemCommand("set_aux_source", { aux: "2", source: 8 }))).toEqual({
      actionId: "set_aux_source",
      params: { aux: 2, source: 8 },
    });
    expect(JSON.parse(buildMobileAtemCommand("cut", { ignored: true }))).toEqual({ actionId: "cut", params: {} });
  });

  it("rejects unknown actions and out-of-range values", () => {
    expect(() => buildMobileAtemCommand("delete_everything", {})).toThrow("not available");
    expect(() => buildMobileAtemCommand("set_program_input", { input: 21 })).toThrow("between 1 and 20");
    expect(() => buildMobileAtemCommand("run_macro", { macro: 1.5 })).toThrow("between 0 and 99");
  });
});
