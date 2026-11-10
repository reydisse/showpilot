import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { getDutyRosterState, writeDutyRoster } from "../duty-roster";
import { executeDutyRosterCommand } from "../duty-roster-command.server";
vi.mock("../push-delivery.server", () => ({
  deliverPushToUser: vi.fn().mockResolvedValue({ sent: 0 }),
}));
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}

const week = "2026-11-08";
const read = (weekStart = week) =>
  getDutyRosterState({ data: { orgId: authenticated.orgId, weekStart } });
async function reviewed(weekStart = week) {
  const snapshot = await read(weekStart);
  return {
    orgId: authenticated.orgId,
    requestId: crypto.randomUUID(),
    weekStart,
    rolesRevision: snapshot.rolesRevision,
  };
}
async function save(
  tech: { roleId: string; userId: string }[] = [],
  pmUserId: string | null = null,
) {
  const state = await read();
  return {
    orgId: authenticated.orgId,
    requestId: crypto.randomUUID(),
    weekStart: week,
    rolesRevision: state.rolesRevision,
    weekRevision: state.weekRevision,
    action: "save-week" as const,
    tech,
    pmUserId,
  };
}
async function role(code = "audio") {
  await writeDutyRoster({
    data: {
      ...(await reviewed()),
      action: "create-role",
      code,
      name: code,
      short: code,
    },
  });
  const found = (await read()).roles.find((role) => role.code === code);
  if (!found) throw new Error("Fixture role missing");
  return found;
}
it("does not leave a partial default role set after an interrupted seed", async () => {
  const data = { ...(await reviewed()), action: "seed-roles" as const };
  await env.DB.exec(
    "CREATE TRIGGER fail_duty_seed BEFORE INSERT ON roster_role WHEN NEW.code='audio' BEGIN SELECT RAISE(ABORT,'fixture role failure'); END;",
  );
  try {
    await expect(writeDutyRoster({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_duty_seed");
  }
  expect((await read()).roles).toHaveLength(0);
  expect((await read()).rolesRevision).toBe(0);
  await writeDutyRoster({ data });
  expect((await read()).roles).toHaveLength(6);
});
it("reports an existing role code instead of silently discarding different role details", async () => {
  await role();
  const data = {
    ...(await reviewed()),
    action: "create-role" as const,
    code: "audio",
    name: "A different role",
    short: "Other",
  };
  expect((await writeDutyRoster({ data })).outcome).toBe("role-code-taken");
  expect((await read()).roles[0].name).toBe("audio");
});
it("keeps assignments when the final role deletion fails", async () => {
  const { userId } = authenticated,
    r = await role();
  await writeDutyRoster({ data: await save([{ roleId: r.id, userId }]) });
  const current = (await read()).roles[0],
    data = {
      ...(await reviewed()),
      action: "delete-role" as const,
      roleId: r.id,
      roleRevision: current.revision,
    };
  await env.DB.exec(
    "CREATE TRIGGER fail_duty_delete BEFORE DELETE ON roster_role BEGIN SELECT RAISE(ABORT,'fixture role delete failure'); END;",
  );
  try {
    await expect(writeDutyRoster({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_duty_delete");
  }
  expect((await read()).tech[r.id]).toBe(userId);
  expect(
    await env.DB.prepare(
      "SELECT id FROM duty_notification_job WHERE removed=1 AND orgId=?",
    )
      .bind(authenticated.orgId)
      .all(),
  ).toMatchObject({ results: [] });
  await writeDutyRoster({ data });
  expect((await read()).roles).toHaveLength(0);
  expect((await read()).tech).toEqual({});
});
it("does not overwrite a newer duty-officer assignment when retrying a lost week-save reply", async () => {
  const { orgId, userId } = authenticated;
  await role();
  const other = await seedRelayMember(crypto.randomUUID());
  await getPrisma().member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: other.userId,
      role: "member",
      createdAt: new Date(),
    },
  });
  const data = await save([], userId);
  await writeDutyRoster({ data });
  const state = await read();
  await writeDutyRoster({
    data: {
      ...(await reviewed()),
      action: "set-officer",
      weekRevision: state.weekRevision,
      duty: "pm",
      userId: other.userId,
    },
  });
  await writeDutyRoster({ data });
  expect((await read()).pmUserId).toBe(other.userId);
});
it("does not clear a new role assignment that was absent from the reviewed week", async () => {
  await role();
  const old = await save();
  const camera = await role("camera");
  await writeDutyRoster({
    data: await save([{ roleId: camera.id, userId: authenticated.userId }]),
  });
  expect((await writeDutyRoster({ data: old })).outcome).toBe("conflict");
  expect((await read()).tech[camera.id]).toBe(authenticated.userId);
});
it("recovers assignment inbox delivery after storage fails following the saved roster", async () => {
  const { orgId, userId } = authenticated,
    data = await save([], userId);
  await env.DB.exec(
    "CREATE TRIGGER fail_duty_notice BEFORE INSERT ON notification WHEN NEW.type='duty-assignment' BEGIN SELECT RAISE(ABORT,'fixture notice failure'); END;",
  );
  try {
    expect(await writeDutyRoster({ data })).toMatchObject({
      outcome: "applied",
      snapshot: { pendingNotifications: 1 },
    });
  } finally {
    await env.DB.exec("DROP TRIGGER fail_duty_notice");
  }
  const saved = (
    await env.DB.prepare("SELECT id FROM roster_assignment WHERE orgId=?")
      .bind(orgId)
      .all()
  ).results;
  expect(await writeDutyRoster({ data })).toMatchObject({
    outcome: "applied",
    snapshot: { pendingNotifications: 0 },
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT id FROM notification WHERE orgId=? AND type='duty-assignment'",
      )
        .bind(orgId)
        .all()
    ).results,
  ).toHaveLength(1);
  expect(
    (
      await env.DB.prepare("SELECT id FROM roster_assignment WHERE orgId=?")
        .bind(orgId)
        .all()
    ).results,
  ).toEqual(saved);
});
it("claims duplicate saves once and rejects changed-payload reuse", async () => {
  const data = await save([], authenticated.userId);
  const replies = await Promise.all([
    writeDutyRoster({ data }),
    writeDutyRoster({ data }),
  ]);
  expect(replies.every((r) => r.outcome === "applied")).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_assignment WHERE orgId=?",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification WHERE orgId=? AND type='duty-assignment'",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 1 });
  await expect(
    writeDutyRoster({ data: { ...data, pmUserId: null } }),
  ).rejects.toThrow("different duty roster command");
});
it("checks access and target membership inside the commit", async () => {
  const data = await save([], authenticated.userId);
  const racing = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare(
        "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
      )
        .bind(data.orgId, authenticated.userId)
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    executeDutyRosterCommand(data, authenticated.actor, racing),
  ).rejects.toThrow("access changed");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM duty_roster_command_receipt WHERE orgId=?",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 0 });
});
it("rejects foreign people and prevents deletion of newly assigned roles", async () => {
  const other = await seedRelayMember(crypto.randomUUID());
  expect(
    (await writeDutyRoster({ data: await save([], other.userId) })).outcome,
  ).toBe("member-unavailable");
  const r = await role(),
    removal = {
      ...(await reviewed()),
      action: "delete-role" as const,
      roleId: r.id,
      roleRevision: r.revision,
    };
  await writeDutyRoster({
    data: await save([{ roleId: r.id, userId: authenticated.userId }]),
  });
  expect((await writeDutyRoster({ data: removal })).outcome).toBe("conflict");
  expect((await read()).tech[r.id]).toBe(authenticated.userId);
});
it("rejects a role or person from another org and scopes receipt identity", async () => {
  const own = authenticated,
    cookie = auth.cookie,
    other = await fixture();
  auth.cookie = cookie;
  await expect(
    writeDutyRoster({ data: { ...(await save()), orgId: other.orgId } }),
  ).rejects.toThrow("permission");
  const data = await save([], own.userId);
  await writeDutyRoster({ data });
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','fixture')",
  )
    .bind(crypto.randomUUID(), own.orgId)
    .run();
  await expect(writeDutyRoster({ data })).rejects.toThrow("permission");
  await expect(read()).rejects.toThrow("permission");
});
it("rolls back the receipt, all slots and notification jobs when a later assignment fails", async () => {
  const r = await role(),
    data = await save(
      [{ roleId: r.id, userId: authenticated.userId }],
      authenticated.userId,
    );
  await env.DB.exec(
    "CREATE TRIGGER fail_tech_slot BEFORE INSERT ON roster_assignment WHEN NEW.kind='tech' BEGIN SELECT RAISE(ABORT,'fixture assignment failure'); END;",
  );
  try {
    await expect(writeDutyRoster({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_tech_slot");
  }
  expect(await read()).toMatchObject({
    weekRevision: 0,
    pmUserId: null,
    tech: {},
    pendingNotifications: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM duty_roster_command_receipt WHERE orgId=? AND requestId=?",
    )
      .bind(data.orgId, data.requestId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM duty_notification_job WHERE orgId=?",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 0 });
  expect((await writeDutyRoster({ data })).outcome).toBe("applied");
  expect((await read()).roles[0].revision).toBe(1);
});
it("rejects target departure at commit, then allows a new reviewed command", async () => {
  const target = await seedRelayMember(
      authenticated.orgId,
      crypto.randomUUID(),
    ),
    data = await save([], target.userId);
  const racing = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare(
        "DELETE FROM member WHERE organizationId=? AND userId=?",
      )
        .bind(data.orgId, target.userId)
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  expect(
    (await executeDutyRosterCommand(data, authenticated.actor, racing)).outcome,
  ).toBe("member-unavailable");
  expect((await writeDutyRoster({ data })).outcome).toBe("member-unavailable");
  expect((await read()).pmUserId).toBeNull();
  expect(
    (await writeDutyRoster({ data: await save([], authenticated.userId) }))
      .outcome,
  ).toBe("applied");
});
it("deletes only the reviewed role across weeks and replays without removing a replacement role", async () => {
  const r = await role(),
    other = await role("tm");
  await writeDutyRoster({
    data: await save([
      { roleId: r.id, userId: authenticated.userId },
      { roleId: other.id, userId: authenticated.userId },
    ]),
  });
  const later = await read("2026-11-15");
  await writeDutyRoster({
    data: {
      ...(await reviewed("2026-11-15")),
      action: "save-week",
      weekRevision: later.weekRevision,
      tech: [{ roleId: r.id, userId: authenticated.userId }],
      pmUserId: null,
    },
  });
  const current = (await read()).roles.find((role) => role.id === r.id);
  if (!current) throw new Error("Role missing");
  const data = {
    ...(await reviewed()),
    action: "delete-role" as const,
    roleId: r.id,
    roleRevision: current.revision,
  };
  expect((await writeDutyRoster({ data })).outcome).toBe("applied");
  const replacement = await role();
  await writeDutyRoster({
    data: await save([
      { roleId: replacement.id, userId: authenticated.userId },
      { roleId: other.id, userId: authenticated.userId },
    ]),
  });
  expect((await writeDutyRoster({ data })).outcome).toBe("applied");
  expect((await read()).tech).toEqual({
    [replacement.id]: authenticated.userId,
    [other.id]: authenticated.userId,
  });
  expect((await read("2026-11-15")).tech).toEqual({});
  expect(
    (
      await env.DB.prepare(
        "SELECT id FROM notification WHERE orgId=? AND title='Your on-duty assignment changed'",
      )
        .bind(data.orgId)
        .all()
    ).results,
  ).toHaveLength(2);
});
it("lets only one competing save win and bounds parameters for a hundred technical roles", async () => {
  const target = await seedRelayMember(
      authenticated.orgId,
      crypto.randomUUID(),
    ),
    a = await save([], authenticated.userId),
    b = { ...a, requestId: crypto.randomUUID(), pmUserId: target.userId };
  const results = await Promise.all([
    writeDutyRoster({ data: a }),
    writeDutyRoster({ data: b }),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "applied",
    "conflict",
  ]);
  const roles = Array.from({ length: 100 }, (_, index) => ({
    id: crypto.randomUUID(),
    code: `role-${index}`,
  }));
  await env.DB.batch(
    roles.map((role) =>
      env.DB.prepare(
        "INSERT INTO roster_role(id,orgId,code,name,short) VALUES(?,?,?,?,?)",
      ).bind(role.id, authenticated.orgId, role.code, role.code, role.code),
    ),
  );
  const data = await save(
    roles.map((role) => ({ roleId: role.id, userId: authenticated.userId })),
  );
  const result = await writeDutyRoster({ data });
  expect(result.outcome).toBe("applied");
  expect(Object.keys(result.snapshot.tech)).toHaveLength(100);
}, 30_000);
it("expires a session before replay and cascades receipts and jobs on organization deletion", async () => {
  const data = await save([], authenticated.userId);
  await writeDutyRoster({ data });
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(writeDutyRoster({ data })).rejects.toThrow();
  await env.DB.prepare("DELETE FROM organization WHERE id=?")
    .bind(authenticated.orgId)
    .run();
  expect(
    (
      await env.DB.prepare(
        "SELECT * FROM duty_roster_command_receipt WHERE orgId=?",
      )
        .bind(data.orgId)
        .all()
    ).results,
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare("SELECT * FROM duty_notification_job WHERE orgId=?")
        .bind(data.orgId)
        .all()
    ).results,
  ).toEqual([]);
});
it("does not show departed members on the kiosk duty roster", async () => {
  const { getRoster } = await import("../kiosk-api"),
    target = await seedRelayMember(authenticated.orgId, crypto.randomUUID());
  await writeDutyRoster({ data: await save([], target.userId) });
  expect(
    (await getRoster(authenticated.orgId, "2026-11")).weeks[0].pm?.id,
  ).toBe(target.userId);
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(authenticated.orgId, target.userId)
    .run();
  expect((await getRoster(authenticated.orgId, "2026-11")).weeks).toEqual([]);
});
it("does not show departed members on the PM duty summary", async () => {
  const { loadRosterDuty } = await import("../pm-dashboard"),
    target = await seedRelayMember(authenticated.orgId, crypto.randomUUID());
  await writeDutyRoster({ data: await save([], target.userId) });
  expect((await loadRosterDuty(authenticated.orgId, week)).pm?.id).toBe(
    target.userId,
  );
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(authenticated.orgId, target.userId)
    .run();
  expect((await loadRosterDuty(authenticated.orgId, week)).pm).toBeNull();
});
it("reports a failed duty summary read instead of pretending no one is assigned", async () => {
  const { loadRosterDuty } = await import("../pm-dashboard");
  await env.DB.exec(
    "ALTER TABLE roster_assignment RENAME TO fixture_unavailable_roster",
  );
  try {
    await expect(loadRosterDuty(authenticated.orgId, week)).rejects.toThrow();
  } finally {
    await env.DB.exec(
      "ALTER TABLE fixture_unavailable_roster RENAME TO roster_assignment",
    );
  }
});
