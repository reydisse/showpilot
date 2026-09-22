import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedDefaultCueColumnsOnce } from "../cue-column-seed";

describe("cue column initialization", () => {
  it("creates one default set under concurrent first loads and does not recreate deleted defaults", async () => {
    const orgId = "cue-seed-org";
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Cue Seed', ?, ?)",
    ).bind(orgId, orgId, now).run();

    await Promise.all([
      seedDefaultCueColumnsOnce(env.DB, orgId, now),
      seedDefaultCueColumnsOnce(env.DB, orgId, now),
    ]);
    const seeded = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM cue_column WHERE orgId = ?",
    ).bind(orgId).first<{ count: number }>();
    expect(seeded?.count).toBe(5);

    await env.DB.prepare("DELETE FROM cue_column WHERE orgId = ?").bind(orgId).run();
    await seedDefaultCueColumnsOnce(env.DB, orgId, new Date().toISOString());
    const afterDelete = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM cue_column WHERE orgId = ?",
    ).bind(orgId).first<{ count: number }>();
    expect(afterDelete?.count).toBe(0);
  });
});
