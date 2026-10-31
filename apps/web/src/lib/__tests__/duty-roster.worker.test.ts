import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { saveDutySlots, createDueDutyReminders, isDutyReminderDue } from "../duty-roster.server";

const push = vi.hoisted(() => vi.fn().mockResolvedValue({ sent: 1 }));
vi.mock("../push-delivery.server", () => ({ deliverPushToUser: push }));

async function fixture() {
  const org = crypto.randomUUID();
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const role = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Duty test', ?, CURRENT_TIMESTAMP)").bind(org, org).run();
  for (const user of users) {
    await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Crew', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
      .bind(user, `${user}@example.test`).run();
    await env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', CURRENT_TIMESTAMP)")
      .bind(crypto.randomUUID(), org, user).run();
  }
  await env.DB.prepare("INSERT INTO roster_role (id, orgId, code, name, short) VALUES (?, ?, 'tm', 'Technical Manager', 'TM')").bind(role, org).run();
  return { org, users, role };
}

describe("weekly duty notifications on real D1", () => {
  it("notifies additions, replacements and removals, but not unchanged or concurrent identical saves", async () => {
    const { org, users, role } = await fixture();
    const first = [{ kind: "pm" as const, roleId: null, userId: users[0] }, { kind: "tech" as const, roleId: role, userId: users[1] }];
    await saveDutySlots(env.DB, org, "2026-11-01", first);
    await Promise.all([saveDutySlots(env.DB, org, "2026-11-01", first), saveDutySlots(env.DB, org, "2026-11-01", first)]);
    let inbox = await env.DB.prepare("SELECT userId, title, actionUrl FROM notification WHERE orgId = ?").bind(org).all();
    expect(inbox.results).toHaveLength(2);
    expect(inbox.results.every((item) => item.actionUrl === "assignments?date=2026-11-01")).toBe(true);
    await saveDutySlots(env.DB, org, "2026-11-01", [{ kind: "pm", roleId: null, userId: users[1] }, { kind: "tech", roleId: role, userId: null }]);
    inbox = await env.DB.prepare("SELECT userId, title FROM notification WHERE orgId = ?").bind(org).all();
    expect(inbox.results).toHaveLength(5);
    expect(inbox.results.filter((item) => item.title === "Your on-duty assignment changed")).toHaveLength(2);
  });
  it("rejects members and roles belonging to another organization before any writes", async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(saveDutySlots(env.DB, a.org, "2026-11-01", [{ kind: "pm", roleId: null, userId: b.users[0] }])).rejects.toThrow("member not found");
    await expect(saveDutySlots(env.DB, a.org, "2026-11-01", [{ kind: "tech", roleId: b.role, userId: a.users[0] }])).rejects.toThrow("role not found");
    const rows = await env.DB.prepare("SELECT id FROM roster_assignment WHERE orgId = ?").bind(a.org).all();
    expect(rows.results).toHaveLength(0);
  });
  it("writes a reminder once across cron retries, honoring push opt-out", async () => {
    const { org, users } = await fixture();
    await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'org-timezone', 'America/Toronto')").bind(crypto.randomUUID(), org).run();
    await env.DB.prepare("INSERT INTO notification_preference (id, orgId, userId, category, deviceAlerts) VALUES (?, ?, ?, 'schedule', 0)").bind(crypto.randomUUID(), org, users[0]).run();
    await saveDutySlots(env.DB, org, "2026-11-01", [{ kind: "pm", roleId: null, userId: users[0] }]);
    push.mockClear();
    await createDueDutyReminders(env.DB, new Date("2026-10-31T12:59:00Z"));
    expect((await env.DB.prepare("SELECT id FROM notification WHERE orgId = ? AND type = 'duty-reminder'").bind(org).all()).results).toHaveLength(0);
    await createDueDutyReminders(env.DB, new Date("2026-10-31T13:00:00Z"));
    await createDueDutyReminders(env.DB, new Date("2026-10-31T13:05:00Z"));
    const reminders = await env.DB.prepare("SELECT deviceAlertEnabled FROM notification WHERE orgId = ? AND type = 'duty-reminder'").bind(org).all();
    expect(reminders.results).toEqual([{ deviceAlertEnabled: 0 }]);
    expect(push.mock.calls.filter((call) => call[0] === org)).toHaveLength(0);
  });
  it("uses local dates across DST and extreme offsets", () => {
    expect(isDutyReminderDue("2026-11-08", "America/Toronto", new Date("2026-11-07T14:00:00Z"))).toBe(true);
    expect(isDutyReminderDue("2026-11-01", "Pacific/Kiritimati", new Date("2026-10-30T19:00:00Z"))).toBe(true);
    expect(isDutyReminderDue("2026-11-01", "America/Toronto", new Date("2026-11-01T14:00:00Z"))).toBe(false);
  });
});
