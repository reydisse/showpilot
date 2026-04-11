import { describe, it, expect } from "vitest";
import { encodeOscMessage, decodeOscMessage } from "../protocols/osc";

describe("OSC encoding", () => {
  it("encodes a simple message with no args", () => {
    const buf = encodeOscMessage("/status", []);
    expect(buf).toBeInstanceOf(Buffer);
    // OSC address must be null-terminated and padded to 4 bytes
    expect(buf.toString("ascii", 0, 7)).toBe("/status");
    expect(buf[7]).toBe(0); // null terminator
  });

  it("encodes a message with float arg", () => {
    const buf = encodeOscMessage("/ch/01/mix/fader", [{ type: "f", value: 0.75 }]);
    expect(buf).toBeInstanceOf(Buffer);
    // Should contain the address, type tag string ",f", and float value
    const str = buf.toString("ascii");
    expect(str).toContain("/ch/01/mix/fader");
  });

  it("encodes a message with int arg", () => {
    const buf = encodeOscMessage("/ch/01/mix/on", [{ type: "i", value: 1 }]);
    expect(buf).toBeInstanceOf(Buffer);
  });

  it("encodes a message with string arg", () => {
    const buf = encodeOscMessage("/node", [{ type: "s", value: "hello" }]);
    expect(buf).toBeInstanceOf(Buffer);
  });

  it("round-trips encode/decode", () => {
    const original = { address: "/test/path", args: [{ type: "f" as const, value: 0.5 }] };
    const encoded = encodeOscMessage(original.address, original.args);
    const decoded = decodeOscMessage(encoded);

    expect(decoded.address).toBe("/test/path");
    expect(decoded.args).toHaveLength(1);
    expect(decoded.args[0].type).toBe("f");
    expect(Math.abs((decoded.args[0].value as number) - 0.5)).toBeLessThan(0.001);
  });

  it("round-trips with int arg", () => {
    const encoded = encodeOscMessage("/mute", [{ type: "i", value: 42 }]);
    const decoded = decodeOscMessage(encoded);
    expect(decoded.address).toBe("/mute");
    expect(decoded.args[0]).toEqual({ type: "i", value: 42 });
  });

  it("round-trips with string arg", () => {
    const encoded = encodeOscMessage("/name", [{ type: "s", value: "test" }]);
    const decoded = decodeOscMessage(encoded);
    expect(decoded.address).toBe("/name");
    expect(decoded.args[0]).toEqual({ type: "s", value: "test" });
  });

  it("pads address to 4-byte boundary", () => {
    const buf = encodeOscMessage("/a", []);
    // "/a" = 2 chars + null = 3 bytes, padded to 4
    expect(buf.length % 4).toBe(0);
  });
});
