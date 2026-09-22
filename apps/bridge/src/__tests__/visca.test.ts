import { describe, expect, it } from "vitest";
import { frameViscaPacket, inspectViscaReply, unframeViscaPacket } from "../protocols/visca";

describe("VISCA UDP framing", () => {
  const home = Buffer.from("81010604ff", "hex");

  it("keeps raw vendor VISCA payloads unframed", () => {
    expect(frameViscaPacket(home, "raw", 7)).toEqual(home);
  });

  it("adds the Sony payload type, length and sequence header", () => {
    expect(frameViscaPacket(home, "sony-ip", 7).toString("hex"))
      .toBe("010000050000000781010604ff");
    expect(frameViscaPacket(Buffer.from("81090400ff", "hex"), "sony-ip", 8, true).toString("hex"))
      .toBe("011000050000000881090400ff");
  });

  it("correlates Sony replies and distinguishes ack, completion and rejection", () => {
    const ack = Buffer.from("01110003000000079041ff", "hex");
    const complete = Buffer.from("01110003000000079051ff", "hex");
    expect(inspectViscaReply(ack, "sony-ip", 7)).toBe("ack");
    expect(inspectViscaReply(complete, "sony-ip", 7)).toBe("complete");
    expect(unframeViscaPacket(complete, "sony-ip", 7).toString("hex")).toBe("9051ff");
    expect(() => inspectViscaReply(complete, "sony-ip", 8)).toThrow("another command");
    expect(() => inspectViscaReply(Buffer.from("906041ff", "hex"), "raw"))
      .toThrow("command not executable");
  });
});
