import { describe, expect, it } from "vitest";
import {
  createChecklistTemplateId,
  findChecklistTemplateId,
} from "../checklist-core";

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
