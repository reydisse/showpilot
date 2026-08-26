import { describe, expect, it } from "vitest";
import { deleteChecklistEntryCore, type ChecklistEntryIdentity } from "../checklist-core";

function inMemoryStore(rows: ChecklistEntryIdentity[]) {
  return {
    rows,
    store: {
      async deleteMany(where: ChecklistEntryIdentity) {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].id === where.id && rows[index].orgId === where.orgId) rows.splice(index, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

describe("checklist entry deletion", () => {
  it("removes only the selected organization entry", async () => {
    const fixture = inMemoryStore([
      { id: "entry-1", orgId: "org-a" },
      { id: "entry-1", orgId: "org-b" },
      { id: "entry-2", orgId: "org-a" },
    ]);

    await expect(deleteChecklistEntryCore({
      store: fixture.store,
      entry: { id: "entry-1", orgId: "org-a" },
    })).resolves.toEqual({ ok: true });

    expect(fixture.rows).toEqual([
      { id: "entry-1", orgId: "org-b" },
      { id: "entry-2", orgId: "org-a" },
    ]);
  });

  it("fails when the entry does not belong to the organization", async () => {
    const fixture = inMemoryStore([{ id: "entry-1", orgId: "org-b" }]);

    await expect(deleteChecklistEntryCore({
      store: fixture.store,
      entry: { id: "entry-1", orgId: "org-a" },
    })).rejects.toThrow("Checklist entry not found");
    expect(fixture.rows).toEqual([{ id: "entry-1", orgId: "org-b" }]);
  });
});
