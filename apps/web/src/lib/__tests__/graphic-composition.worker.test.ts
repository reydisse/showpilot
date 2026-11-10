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
    const retry = await publishGraphicCompositionForOrg(env.DB, { orgId, requestId: "good-revision", items: [item("one", "New A"), item("two", "New B")] });
    expect(first.isActive).toBe(true);
    const marker = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key='graphic-publish:good-revision'").bind(orgId).first<{value:string}>();
    expect(JSON.parse(marker?.value ?? "null")).toEqual(first.publishedIds);
    expect(first.publishedIds).toHaveLength(2);
    expect(first.publishedIds.every((id) => /^live-[a-f0-9]{24}-\d+$/.test(id))).toBe(true);
    expect(retry.publishedIds).toEqual(first.publishedIds);
    await expect(publishGraphicCompositionForOrg(env.DB, { orgId, requestId: "good-revision", items: [item("one", "Changed retry payload")] })).rejects.toThrow("different content");
    expect(await env.DB.prepare("SELECT title FROM graphic_template WHERE id = 'old-live'").first<{ title: string }>()).toEqual({ title: "Old title" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM graphic_template WHERE orgId = ? AND id IN (?, ?)").bind(orgId, ...first.publishedIds).first<{ count: number }>()).toEqual({ count: 2 });
  });
});

it("does not let a delayed duplicate publication replace a newer Program", async () => {
  const orgId = `composition-race-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Race',?,CURRENT_TIMESTAMP)").bind(orgId,orgId).run();
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { arrived(); await held; return target.batch(statements); };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const original = { orgId, requestId: "first-publication", items: [item("one", "First")] };
  const late = publishGraphicCompositionForOrg(delayed, original);
  await waiting;
  await publishGraphicCompositionForOrg(env.DB, original);
  const newer = await publishGraphicCompositionForOrg(env.DB, { orgId, requestId: "second-publication", items: [item("two", "Newer")] });
  release();
  const replay = await late;
  expect(replay.activeIds).toEqual(newer.publishedIds);
  expect(replay.isActive).toBe(false);
});

it("retains old receipts and cannot republish a recorded legacy request", async () => {
  const orgId=`legacy-composition-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Legacy',?,CURRENT_TIMESTAMP)").bind(orgId,orgId).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'graphic-publish:legacy','[\"old\"]')").bind(crypto.randomUUID(),orgId).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-graphics','[\"newer\"]')").bind(crypto.randomUUID(),orgId).run();
  await expect(publishGraphicCompositionForOrg(env.DB,{orgId,requestId:"legacy",items:[item("one","Must not publish")]})).rejects.toThrow("different content");
  expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key='active-graphics'").bind(orgId).first()).toEqual({value:'["newer"]'});
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM graphic_template WHERE orgId=?").bind(orgId).first()).toEqual({count:0});
});
