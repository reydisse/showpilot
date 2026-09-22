import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publishGraphicCompositionForOrg, type GraphicCompositionItem } from "../graphic-composition";

const item = (key: string, title: string): GraphicCompositionItem => ({
  key,
  name: title,
  title,
  subtitle: "Subtitle",
  style: JSON.stringify({ type: "lower-third", templateId: "classic", controls: {} }),
});

describe("atomic graphic composition publishing", () => {
  it("keeps the prior Program on preparation failure and publishes immutable revisions idempotently", async () => {
    const orgId = `composition-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Graphics', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
    await env.DB.prepare("INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt) VALUES ('old-live', ?, 'Old', 'Old title', '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").bind(orgId).run();
    await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'active-graphics', '[\"old-live\"]')").bind(crypto.randomUUID(), orgId).run();

    await expect(publishGraphicCompositionForOrg(env.DB, {
      orgId,
      requestId: "failed-revision",
      items: [item("one", "Prepared"), { ...item("two", "Invalid"), name: null } as unknown as GraphicCompositionItem],
    })).rejects.toThrow();

    const afterFailure = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'").bind(orgId).first<{ value: string }>();
    expect(JSON.parse(afterFailure?.value ?? "[]")).toEqual(["old-live"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM graphic_template WHERE orgId = ? AND title = 'Prepared'").bind(orgId).first<{ count: number }>()).toEqual({ count: 0 });

    const first = await publishGraphicCompositionForOrg(env.DB, { orgId, requestId: "good-revision", items: [item("one", "New A"), item("two", "New B")] });
    const retry = await publishGraphicCompositionForOrg(env.DB, { orgId, requestId: "good-revision", items: [item("one", "Changed retry payload")] });
    expect(first.isActive).toBe(true);
    expect(first.publishedIds).toHaveLength(2);
    expect(first.publishedIds.every((id) => /^live-[a-f0-9]{24}-\d+$/.test(id))).toBe(true);
    expect(retry.publishedIds).toEqual(first.publishedIds);
    expect(await env.DB.prepare("SELECT title FROM graphic_template WHERE id = 'old-live'").first<{ title: string }>()).toEqual({ title: "Old title" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM graphic_template WHERE orgId = ? AND id IN (?, ?)").bind(orgId, ...first.publishedIds).first<{ count: number }>()).toEqual({ count: 2 });
  });
});
