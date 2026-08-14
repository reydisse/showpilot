import { describe, expect, it } from "vitest";
import { normalizeLiveInputStatus } from "@/lib/stream-health";

describe("normalizeLiveInputStatus", () => {
  it.each(["connected", "reconnected", "live_streaming"])("treats %s as actively streaming", (status) => {
    expect(normalizeLiveInputStatus(status)).toBe("streaming");
  });

  it.each(["reconnecting", "new_configuration_accepted"])("keeps %s distinct from healthy", (status) => {
    expect(normalizeLiveInputStatus(status)).toBe("connecting");
  });

  it.each(["ttl_exceeded", "failed_to_connect", "failed_to_reconnect"])("surfaces %s as an error", (status) => {
    expect(normalizeLiveInputStatus(status)).toBe("error");
  });

  it("does not report disabled or unknown inputs as live", () => {
    expect(normalizeLiveInputStatus("idle", false)).toBe("disabled");
    expect(normalizeLiveInputStatus("unexpected")).toBe("idle");
  });
});
