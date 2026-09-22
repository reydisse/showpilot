import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ChecklistRevisionConflictError,
  setChecklistEntryCategory,
  transitionChecklistEntry,
} from "../checklist-toggle.server";

async function seed() {
  const suffix = crypto.randomUUID();
  const orgId = `checklist-org-${suffix}`;
  const showA = `show-a-${suffix}`;
  const showB = `show-b-${suffix}`;
  const templateId = `template-${suffix}`;
  const entryA = `entry-a-${suffix}`;
  const entryB = `entry-b-${suffix}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)").bind(orgId, "Checklist", orgId, now),
    env.DB.prepare("INSERT INTO rundown (id, orgId, name, serviceDate, createdAt, updatedAt) VALUES (?, ?, ?, '2026-09-22', ?, ?)").bind(showA, orgId, "A", now, now),
    env.DB.prepare("INSERT INTO rundown (id, orgId, name, serviceDate, createdAt, updatedAt) VALUES (?, ?, ?, '2026-09-22', ?, ?)").bind(showB, orgId, "B", now, now),
    env.DB.prepare("INSERT INTO checklist_template (id, orgId, label, category, sortOrder, createdAt) VALUES (?, ?, 'Line check', 'audio', 0, ?)").bind(templateId, orgId, now),
    env.DB.prepare("INSERT INTO checklist_entry (id, orgId, templateId, showId, serviceDate, category, checked, revision) VALUES (?, ?, ?, ?, '2026-09-22', 'audio', 0, 0)").bind(entryA, orgId, templateId, showA),
    env.DB.prepare("INSERT INTO checklist_entry (id, orgId, templateId, showId, serviceDate, category, checked, revision) VALUES (?, ?, ?, ?, '2026-09-22', 'audio', 0, 0)").bind(entryB, orgId, templateId, showB),
  ]);
  return { orgId, entryA, entryB };
}

describe("checklist entry state", () => {
  it("keeps department edits scoped to one show entry", async () => {
    const { orgId, entryA, entryB } = await seed();
    await setChecklistEntryCategory({ orgId, entryId: entryA, category: "video", database: env.DB });
    const rows = await env.DB.prepare(
      "SELECT id, category FROM checklist_entry WHERE id IN (?, ?) ORDER BY id",
    ).bind(entryA, entryB).all<{ id: string; category: string }>();
    expect(new Map(rows.results.map((row) => [row.id, row.category]))).toEqual(new Map([
      [entryA, "video"],
      [entryB, "audio"],
    ]));
  });

  it("preserves first completion metadata on retry and rejects stale conflicting state", async () => {
    const { orgId, entryA } = await seed();
    const firstTime = new Date("2026-09-22T10:00:00.000Z");
    const first = await transitionChecklistEntry({
      orgId, entryId: entryA, checked: true, expectedRevision: 0, actorName: "First Operator", database: env.DB, now: firstTime,
    });
    expect(first).toMatchObject({ checked: true, checkedBy: "First Operator", checkedAt: firstTime.toISOString(), revision: 1 });

    const retry = await transitionChecklistEntry({
      orgId, entryId: entryA, checked: true, expectedRevision: 0, actorName: "Retrying Operator", database: env.DB, now: new Date("2026-09-22T11:00:00.000Z"),
    });
    expect(retry).toMatchObject({ checked: true, checkedBy: "First Operator", checkedAt: firstTime.toISOString(), revision: 1 });

    await expect(transitionChecklistEntry({
      orgId, entryId: entryA, checked: false, expectedRevision: 0, actorName: "Stale Operator", database: env.DB,
    })).rejects.toBeInstanceOf(ChecklistRevisionConflictError);

    const unchecked = await transitionChecklistEntry({
      orgId, entryId: entryA, checked: false, expectedRevision: 1, actorName: "Current Operator", database: env.DB,
    });
    expect(unchecked).toMatchObject({ checked: false, checkedBy: null, checkedAt: null, revision: 2 });
  });
});
