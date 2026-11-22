import { expect, it } from "vitest";
import { cueCellKey, cueDraftKey, restoreCueDrafts, serializeCueDrafts, type CueDraft } from "../cue-sheet-offline";
const draft: CueDraft = { showId: "show", serviceDate: "2026-11-22", itemId: "welcome", columnId: "lx", text: "A later local edit", expectedText: "Original", pending: true, version: 2,
  request: { orgId: "demo", requestId: "426d168a-7c08-41b7-8741-63448ea53dce", operation: { kind: "note", showId: "show", serviceDate: "2026-11-22", itemId: "welcome", columnId: "lx", expectedText: "Original", text: "First edit sent before the connection dropped" } } };

it("preserves the captured request and newer local text separately across a reload", () => {
  const source = new Map([[cueCellKey("show", "welcome", "lx"), draft]]);
  const recovered = restoreCueDrafts(serializeCueDrafts(source), "demo");
  expect(recovered.get(cueCellKey("show", "welcome", "lx"))).toEqual(draft);
  expect(JSON.stringify(recovered.values().next().value?.request)).toBe(JSON.stringify(draft.request));
  expect(cueDraftKey("demo", "lighting-user")).not.toBe(cueDraftKey("demo", "sound-user"));
  expect(cueDraftKey("demo", "lighting-user")).not.toBe(cueDraftKey("other-demo", "lighting-user"));
});
it("never restores a foreign receipt, a different cell, a destructive operation, or invalid data", () => {
  for (const invalid of [
    { ...draft, request: { ...draft.request, orgId: "foreign" } },
    { ...draft, request: { ...draft.request, operation: { ...draft.request!.operation, itemId: "another-item" } } },
    { ...draft, request: { ...draft.request, operation: { kind: "delete-column", id: "lx", label: "LX" } } },
    { ...draft, text: "x".repeat(2001) }, { ...draft, version: -1 },
  ]) expect(() => restoreCueDrafts(JSON.stringify([invalid]), "demo")).toThrow();
  expect(() => restoreCueDrafts("not json", "demo")).toThrow();
  expect(() => restoreCueDrafts(JSON.stringify([draft, draft]), "demo")).toThrow();
});
it("keeps only pending cues and can recover a cue captured before any transport attempt", () => {
  const pending = { ...draft, request: undefined };
  const source = new Map([["pending", pending], ["saved", { ...draft, pending: false }]]);
  const restored = restoreCueDrafts(serializeCueDrafts(source), "demo");
  expect(restored.size).toBe(1); expect(restored.values().next().value?.request).toBeUndefined();
});
