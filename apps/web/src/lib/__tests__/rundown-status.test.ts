import { describe, expect, it } from "vitest";
import {
  mobileRundownStatus,
  persistedRundownStatus,
  rundownPhaseStatus,
} from "../rundown-status";

describe("rundown run status", () => {
  it("persists timer playback as the mobile run-state vocabulary", () => {
    expect(persistedRundownStatus("play")).toBe("running");
    expect(persistedRundownStatus("pause")).toBe("paused");
    expect(persistedRundownStatus("stop")).toBe("stopped");
  });

  it("repairs stale stored state from the authoritative timer", () => {
    expect(mobileRundownStatus("play", "stopped")).toBe("running");
    expect(mobileRundownStatus("pause", "stopped")).toBe("paused");
    expect(mobileRundownStatus("stop", "running")).toBe("stopped");
    expect(mobileRundownStatus("stop", "complete")).toBe("complete");
  });

  it("maps all active persisted states to the web phase model", () => {
    expect(rundownPhaseStatus("live")).toBe("live");
    expect(rundownPhaseStatus("running")).toBe("live");
    expect(rundownPhaseStatus("paused")).toBe("live");
    expect(rundownPhaseStatus("complete")).toBe("complete");
    expect(rundownPhaseStatus("draft")).toBe("stopped");
  });
});
