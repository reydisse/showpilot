import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setGraphicPresenceForOrg } from "../active-graphics";

describe("active graphic atomic presence", () => {
  it("preserves concurrent additions and idempotent removals", async () => {
    const orgId = `graphics-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(orgId, "Graphics", orgId, new Date().toISOString()).run();

    await Promise.all([
      setGraphicPresenceForOrg(env.DB, orgId, "graphic-a", true),
      setGraphicPresenceForOrg(env.DB, orgId, "graphic-b", true),
    ]);
    const stored = await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'",
    ).bind(orgId).first<{ value: string }>();
    expect(new Set(JSON.parse(stored?.value ?? "[]"))).toEqual(new Set(["graphic-a", "graphic-b"]));

    await Promise.all([
      setGraphicPresenceForOrg(env.DB, orgId, "graphic-a", false),
      setGraphicPresenceForOrg(env.DB, orgId, "graphic-a", false),
    ]);
    const after = await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'active-graphics'",
    ).bind(orgId).first<{ value: string }>();
    expect(JSON.parse(after?.value ?? "[]")).toEqual(["graphic-b"]);
  });
});
