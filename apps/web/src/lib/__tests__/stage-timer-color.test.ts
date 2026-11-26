import { describe, expect, it } from "vitest";
import { RECEDED_TIMER_COLOR, secondaryTimerColor } from "@/lib/stage-timer-color";

describe("secondaryTimerColor", () => {
  it("lets a calm countdown recede behind a priority message", () => {
    expect(secondaryTimerColor("normal", "#ffffff")).toBe(RECEDED_TIMER_COLOR);
  });

  it.each(["alert", "danger", "overtime"] as const)("keeps the %s colour visible", (phase) => {
    expect(secondaryTimerColor(phase, "#ef4444")).toBe("#ef4444");
  });
});
