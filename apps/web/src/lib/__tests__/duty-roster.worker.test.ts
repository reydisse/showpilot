import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  createDueDutyReminders,
  isDutyReminderDue,
} from "../duty-roster.server";

import { executeDutyRosterCommand } from "../duty-roster-command.server";
import { readDutyRoster, type DutySlot } from "../duty-roster-storage.server";
import { seedRelayMember } from "@/test/relay-fixtures";

const push = vi.hoisted(() => vi.fn().mockResolvedValue({ sent: 1 }));
vi.mock("../push-delivery.server", () => ({ deliverPushToUser: push }));

async function fixture() {
  const org = crypto.randomUUID();
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const role = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Duty test', ?, CURRENT_TIMESTAMP)",
  )
    .bind(org, org)
    .run();
  for (const user of users) {
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Crew', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    )
      .bind(user, `${user}@example.test`)
      .run();
    await env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', CURRENT_TIMESTAMP)",
    )
      .bind(crypto.randomUUID(), org, user)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO roster_role (id, orgId, code, name, short) VALUES (?, ?, 'tm', 'Technical Manager', 'TM')",
  )
    .bind(role, org)
    .run();
  const actor = await seedRelayMember(org);
  return { org, users, role, actor };
}

async function assign(
  f: Awaited<ReturnType<typeof fixture>>,
  slots: Omit<DutySlot, "roleName">[],
) {
  const state = await readDutyRoster(env.DB, f.org, "2026-11-01");
  const tech = { ...state.tech };
  let pmUserId = state.pmUserId;
  for (const slot of slots) {
    if (slot.kind === "pm") pmUserId = slot.userId;
    else if (slot.roleId) {
      if (slot.userId) tech[slot.roleId] = slot.userId;
      else delete tech[slot.roleId];
    }
  }
  return executeDutyRosterCommand(
    {
      action: "save-week",
      orgId: f.org,
      weekStart: "2026-11-01",
      requestId: crypto.randomUUID(),
      rolesRevision: state.rolesRevision,
      weekRevision: state.weekRevision,
      tech: Object.entries(tech).map(([roleId, userId]) => ({
        roleId,
        userId,
      })),
      pmUserId,
    },
    f.actor,
  );
}

describe("weekly duty notifications on real D1", () => {
  it("notifies additions, replacements and removals, but not unchanged or concurrent identical saves", async () => {
    const f = await fixture();
    const { org, users, role } = f;
    const first = [
      { kind: "pm" as const, roleId: null, userId: users[0] },
      { kind: "tech" as const, roleId: role, userId: users[1] },
    ];
    await assign(f, first);
    await Promise.all([assign(f, first), assign(f, first)]);
    let inbox = await env.DB.prepare(
      "SELECT userId, title, actionUrl FROM notification WHERE orgId = ?",
    )
      .bind(org)
      .all();
    expect(inbox.results).toHaveLength(2);
    expect(
      inbox.results.every(
        (item) => item.actionUrl === "assignments?date=2026-11-01",
      ),
    ).toBe(true);
    await assign(f, [
      { kind: "pm", roleId: null, userId: users[1] },
      { kind: "tech", roleId: role, userId: null },
    ]);
    inbox = await env.DB.prepare(
      "SELECT userId, title FROM notification WHERE orgId = ?",
    )
      .bind(org)
      .all();
    expect(inbox.results).toHaveLength(5);
    expect(
      inbox.results.filter(
        (item) => item.title === "Your on-duty assignment changed",
      ),
    ).toHaveLength(2);
  });
  it("rejects members and roles belonging to another organization before any writes", async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(
      assign(a, [{ kind: "pm", roleId: null, userId: b.users[0] }]),
    ).resolves.toMatchObject({ outcome: "member-unavailable" });
    await expect(
      assign(a, [{ kind: "tech", roleId: b.role, userId: a.users[0] }]),
    ).resolves.toMatchObject({ outcome: "conflict" });
    const rows = await env.DB.prepare(
      "SELECT id FROM roster_assignment WHERE orgId = ?",
    )
      .bind(a.org)
      .all();
    expect(rows.results).toHaveLength(0);
  });
  it("writes a reminder once across cron retries, honoring push opt-out", async () => {
    const f = await fixture();
    const { org, users } = f;
    await env.DB.prepare(
      "INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'org-timezone', 'America/Toronto')",
    )
      .bind(crypto.randomUUID(), org)
      .run();
    await env.DB.prepare(
      "INSERT INTO notification_preference (id, orgId, userId, category, deviceAlerts) VALUES (?, ?, ?, 'schedule', 0)",
    )
      .bind(crypto.randomUUID(), org, users[0])
      .run();
    await assign(f, [{ kind: "pm", roleId: null, userId: users[0] }]);
    push.mockClear();
    await createDueDutyReminders(env.DB, new Date("2026-10-31T12:59:00Z"));
    expect(
      (
        await env.DB.prepare(
          "SELECT id FROM notification WHERE orgId = ? AND type = 'duty-reminder'",
        )
          .bind(org)
          .all()
      ).results,
    ).toHaveLength(0);
    await createDueDutyReminders(env.DB, new Date("2026-10-31T13:00:00Z"));
    await createDueDutyReminders(env.DB, new Date("2026-10-31T13:05:00Z"));
    const reminders = await env.DB.prepare(
      "SELECT deviceAlertEnabled FROM notification WHERE orgId = ? AND type = 'duty-reminder'",
    )
      .bind(org)
      .all();
    expect(reminders.results).toEqual([{ deviceAlertEnabled: 0 }]);
    expect(push.mock.calls.filter((call) => call[0] === org)).toHaveLength(0);
  });
  it("uses local dates across DST and extreme offsets", () => {
    expect(
      isDutyReminderDue(
        "2026-11-08",
        "America/Toronto",
        new Date("2026-11-07T14:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isDutyReminderDue(
        "2026-11-01",
        "Pacific/Kiritimati",
        new Date("2026-10-30T19:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isDutyReminderDue(
        "2026-11-01",
        "America/Toronto",
        new Date("2026-11-01T14:00:00Z"),
      ),
    ).toBe(false);
  });
});
it("cron recovers failed assignment notifications once using the recipient's latest preferences", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fail_duty_delivery BEFORE INSERT ON notification WHEN NEW.type='duty-assignment' BEGIN SELECT RAISE(ABORT,'fixture notification failure'); END;",
  );
  try {
    expect(
      (await assign(f, [{ kind: "pm", roleId: null, userId: f.users[0] }]))
        .snapshot.pendingNotifications,
    ).toBe(1);
  } finally {
    await env.DB.exec("DROP TRIGGER fail_duty_delivery");
  }
  await env.DB.prepare(
    "INSERT INTO notification_preference(id,orgId,userId,category,deviceAlerts) VALUES(?,?,?,'schedule',0)",
  )
    .bind(crypto.randomUUID(), f.org, f.users[0])
    .run();
  push.mockClear();
  await createDueDutyReminders(env.DB, new Date("2026-10-01T09:00:00Z"));
  await createDueDutyReminders(env.DB, new Date("2026-10-01T09:05:00Z"));
  expect(
    (
      await env.DB.prepare(
        "SELECT deviceAlertEnabled FROM notification WHERE orgId=?",
      )
        .bind(f.org)
        .all()
    ).results,
  ).toEqual([{ deviceAlertEnabled: 0 }]);
  expect(
    (await readDutyRoster(env.DB, f.org, "2026-11-01")).pendingNotifications,
  ).toBe(0);
  expect(push.mock.calls.filter((call) => call[0] === f.org)).toHaveLength(0);
});
it("skips superseded assignments and departed recipients when retrying queued notifications", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fail_stale_duty BEFORE INSERT ON notification WHEN NEW.type='duty-assignment' BEGIN SELECT RAISE(ABORT,'fixture notification failure'); END;",
  );
  try {
    await assign(f, [{ kind: "pm", roleId: null, userId: f.users[0] }]);
    await assign(f, [{ kind: "pm", roleId: null, userId: f.users[1] }]);
  } finally {
    await env.DB.exec("DROP TRIGGER fail_stale_duty");
  }
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(f.org, f.users[0])
    .run();
  push.mockClear();
  await createDueDutyReminders(env.DB, new Date("2026-10-01T09:00:00Z"));
  expect(
    (
      await env.DB.prepare(
        "SELECT userId,title FROM notification WHERE orgId=?",
      )
        .bind(f.org)
        .all()
    ).results,
  ).toEqual([{ userId: f.users[1], title: "You’re on duty" }]);
  expect(
    (await readDutyRoster(env.DB, f.org, "2026-11-01")).pendingNotifications,
  ).toBe(0);
});
