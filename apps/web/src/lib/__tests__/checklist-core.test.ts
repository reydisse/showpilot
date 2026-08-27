import { describe, expect, it } from "vitest";
import {
  createChecklistTemplateId,
  deleteChecklistEntryCore,
  findChecklistTemplateId,
  type ChecklistEntryIdentity,
} from "../checklist-core";

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

describe("checklist template identity", () => {
  it("reuses a matching template across casing and punctuation", () => {
    expect(findChecklistTemplateId([
      { id: "template-a", label: "Test VIDEO playback!" },
      { id: "template-b", label: "Comms check" },
    ], " test video playback ")).toBe("template-a");
  });

  it("rejects labels without a meaningful identity", () => {
    expect(() => findChecklistTemplateId([], " !!! ")).toThrow(
      "Checklist items must include letters or numbers",
    );
  });

  it("creates a stable id for concurrent creators in one organization", async () => {
    const first = await createChecklistTemplateId("org-a", "Camera checks");
    const retry = await createChecklistTemplateId("org-a", " camera checks! ");
    const otherOrganization = await createChecklistTemplateId("org-b", "Camera checks");

    expect(first).toBe(retry);
    expect(first).toMatch(/^checklist-[a-f0-9]{40}$/);
    expect(otherOrganization).not.toBe(first);
  });
});
