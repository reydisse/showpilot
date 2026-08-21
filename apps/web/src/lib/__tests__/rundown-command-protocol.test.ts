import { describe, expect, it } from "vitest";
import { classifyRelayCommand } from "../rundown-command-protocol";

describe("rundown command arbitration", () => {
  it("allows only one of two operators acting on the same revision", () => {
    const revisionSeenByBothOperators = 12;

    expect(
      classifyRelayCommand(12, [], "operator-a-next", revisionSeenByBothOperators),
    ).toBe("apply");

    // Operator A applied and advanced the authoritative revision to 13.
    expect(
      classifyRelayCommand(13, ["operator-a-next"], "operator-b-next", revisionSeenByBothOperators),
    ).toBe("revision-conflict");
  });

  it("acknowledges a retried command without applying it twice", () => {
    expect(classifyRelayCommand(8, ["timer-start-1"], "timer-start-1", 7)).toBe("duplicate");
  });

  it("keeps revision-less integration commands backward compatible", () => {
    expect(classifyRelayCommand(8, [], undefined, undefined)).toBe("apply");
  });
});
