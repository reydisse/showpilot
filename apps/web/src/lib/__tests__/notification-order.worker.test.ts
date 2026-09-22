import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("notification timestamp ordering", () => {
  it("sorts mixed legacy formats by their actual instant with a stable tie-breaker", async () => {
    const orgId = "notification-order-org";
    const userId = "notification-order-user";
    await env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Notifications', ?, CURRENT_TIMESTAMP)`,
    ).bind(orgId, orgId).run();
    await env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Notifier', 'notifier@example.com', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(userId).run();
    const insert = (id: string, createdAt: string) => env.DB.prepare(
      `INSERT INTO notification
       (id, orgId, userId, type, severity, title, message, target, source, actionUrl, category, deviceAlertEnabled, dismissed, createdAt)
       VALUES (?, ?, ?, 'test', 'info', ?, '', '', ?, '', 'system', 0, 0, ?)`,
    ).bind(id, orgId, userId, id, id, createdAt).run();
    await insert("older-iso", "2026-09-21T20:39:19.065+00:00");
    await insert("newer-space", "2026-09-21 21:59:07");
    await insert("newer-space-b", "2026-09-21 21:59:07");

    const result = await env.DB.prepare(
      `SELECT id FROM notification WHERE orgId = ? AND userId = ?
       ORDER BY julianday(createdAt) DESC, id DESC`,
    ).bind(orgId, userId).all<{ id: string }>();
    expect(result.results?.map((row) => row.id)).toEqual([
      "newer-space-b",
      "newer-space",
      "older-iso",
    ]);
  });
});
