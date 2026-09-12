import { describe, expect, it } from "vitest";
import { decodeStageMessage, encodeStageMessage } from "../stage-message";

describe("stage messages", () => {
  it("round-trips normal and priority messages", () => {
    expect(decodeStageMessage(encodeStageMessage("  Stand by  ", false))).toEqual({
      text: "Stand by",
      priority: false,
    });
    expect(decodeStageMessage(encodeStageMessage("  Clear the stage  ", true))).toEqual({
      text: "Clear the stage",
      priority: true,
    });
  });

  it("does not encode an empty priority message", () => {
    expect(encodeStageMessage("   ", true)).toBe("");
  });
});
