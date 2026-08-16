import { describe, expect, it } from "vitest";
import { rundownRelayKey } from "../rundown-relay-key";

describe("rundown relay isolation", () => {
  it("keeps today's live service on the integration-compatible org relay", () => {
    expect(rundownRelayKey("org-1", "2026-08-16", "2026-08-16")).toBe("org-1");
    expect(rundownRelayKey("org-1", null, "2026-08-16")).toBe("org-1");
  });

  it("isolates planning and historical dates from the live relay", () => {
    expect(rundownRelayKey("org-1", "2026-08-23", "2026-08-16")).toBe("org-1:2026-08-23");
    expect(rundownRelayKey("org-1", "2026-08-09", "2026-08-16")).toBe("org-1:2026-08-09");
  });
});
