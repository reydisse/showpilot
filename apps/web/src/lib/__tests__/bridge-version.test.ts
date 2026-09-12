import { describe, expect, it } from "vitest";
import { isBridgeVersionAtLeast } from "../bridge-version";

describe("Bridge protocol version", () => {
  it("accepts the required version and newer compatible versions", () => {
    expect(isBridgeVersionAtLeast("0.1.11", "0.1.11")).toBe(true);
    expect(isBridgeVersionAtLeast("0.2.0", "0.1.11")).toBe(true);
    expect(isBridgeVersionAtLeast("1.0.0-beta.1", "0.1.11")).toBe(true);
  });

  it("rejects old, missing, and malformed Bridge versions", () => {
    expect(isBridgeVersionAtLeast("0.1.10", "0.1.11")).toBe(false);
    expect(isBridgeVersionAtLeast(undefined, "0.1.11")).toBe(false);
    expect(isBridgeVersionAtLeast("0.1", "0.1.11")).toBe(false);
  });
});
