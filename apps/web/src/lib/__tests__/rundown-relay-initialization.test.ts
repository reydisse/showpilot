import { describe, expect, it } from "vitest";
import {
  inferRundownRelayInitialized,
  shouldAcceptRundownSeed,
} from "@/lib/rundown-relay-initialization";

describe("rundown relay initialization", () => {
  it("preserves the explicit state even when a room has a high revision", () => {
    expect(
      inferRundownRelayInitialized({ initialized: false, revision: 42 }),
    ).toBe(false);
    expect(
      inferRundownRelayInitialized({ initialized: true, revision: 0 }),
    ).toBe(true);
  });

  it("recognizes legacy rooms that already owned rundown state", () => {
    expect(inferRundownRelayInitialized({ items: [{}], revision: 1 })).toBe(
      true,
    );
    expect(inferRundownRelayInitialized({ items: [], revision: 2 })).toBe(true);
  });

  it("leaves a freshly relabelled legacy room available for its first seed", () => {
    expect(inferRundownRelayInitialized({ items: [], revision: 1 })).toBe(
      false,
    );
  });

  it("accepts one initial seed and only permits later forced replacements", () => {
    expect(shouldAcceptRundownSeed(false, false)).toBe(true);
    expect(shouldAcceptRundownSeed(true, false)).toBe(false);
    expect(shouldAcceptRundownSeed(true, true)).toBe(true);
  });
});
