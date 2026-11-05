import { describe, expect, it } from "vitest";
import { restoreRundownItem } from "../rundown-undo";

describe("undo rundown item deletion", () => {
  it("restores before the original next row and preserves concurrent edits", () => {
    const current = [{ id: "new", title: "Added elsewhere" }, { id: "next", title: "Updated elsewhere" }];
    const item = { id: "removed", title: "Removed" };
    expect(restoreRundownItem(current, { item, index: 0, nextId: "next" })).toEqual([current[0], item, current[1]]);
    expect(current).toHaveLength(2);
  });
  it("does not duplicate a row restored by the relay or another operator", () => {
    const current = [{ id: "removed", title: "Latest version" }];
    expect(restoreRundownItem(current, { item: { id: "removed", title: "Old version" }, index: 0, nextId: null })).toEqual(current);
  });
  it("restores at the nearest remaining position if the following row disappeared", () => {
    const item = { id: "removed" };
    expect(restoreRundownItem([{ id: "first" }], { item, index: 2, nextId: "gone" })).toEqual([{ id: "first" }, item]);
  });
});
