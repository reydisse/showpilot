import { describe, expect, it } from "vitest";
import {
  canApplyRundownRelayAction,
  classifyRelayCommand,
  parseRundownRelayHttpCommand,
} from "../rundown-command-protocol";

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

  it("validates HTTP command envelopes at the relay boundary", () => {
    expect(parseRundownRelayHttpCommand({
      action: "update-item",
      id: "edit-1",
      expectedRevision: 12,
      payload: { id: "item-1", updates: { title: "Welcome" } },
    })).toEqual({
      action: "update-item",
      id: "edit-1",
      expectedRevision: 12,
      payload: { id: "item-1", updates: { title: "Welcome" } },
    });
    expect(parseRundownRelayHttpCommand({ action: "timer-next", expectedRevision: -1 })).toBeNull();
    expect(parseRundownRelayHttpCommand({ action: "timer-next", payload: [] })).toBeNull();
  });

  it("separates rundown editing from live transport control", () => {
    expect(canApplyRundownRelayAction("edit", "update-item")).toBe(true);
    expect(canApplyRundownRelayAction("edit", "update-meta")).toBe(true);
    expect(canApplyRundownRelayAction("edit", "timer-next")).toBe(false);
    expect(canApplyRundownRelayAction("control", "timer-next")).toBe(true);
  });
});
