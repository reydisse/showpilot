import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import {
  grantMemberAccess,
  revokeMemberAccess,
  getAccessManagementSnapshotForActor,
  retryAccessGrantNotification,
} from "../access-grants";
import { resolveAccessGrantAuthority } from "../effective-access";
const effects = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }));
vi.mock("../relay-read-invalidation.server", () => ({
  refreshOrgReadAuthority: effects.refresh,
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
  vi.restoreAllMocks();
  effects.refresh.mockReset().mockResolvedValue(undefined);
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
  const target = await getPrisma().user.create({
    data: {
      id: crypto.randomUUID(),
      name: "Target operator",
      email: `${crypto.randomUUID()}@example.test`,
      emailVerified: true,
    },
  });
  await getPrisma().member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: target.id,
      role: "member",
      createdAt: new Date(),
    },
  });
  const authority = await resolveAccessGrantAuthority(env.DB, userId, orgId);
  const input = {
    orgId,
    userId: target.id,
    capability: "rundown-operator" as const,
    duration: "this-week" as const,
    reason: "Covering production",
    requestId: crypto.randomUUID(),
    expectedWeekStart: authority.weekStart,
  };
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  const actor = {
    userId,
    name: session.user.name,
    sessionId: session.session.id,
  };
  return { orgId, userId, targetId: target.id, input, authority, actor };
}

it("recovers a committed grant after its acknowledgement was lost", async () => {
  const f = authenticated;
  const first = await grantMemberAccess({ data: f.input });
  expect(await grantMemberAccess({ data: f.input })).toMatchObject({
    id: first.id,
  });
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId },
    }),
  ).toBe(1);
  expect(
    await getPrisma().notification.count({
      where: { orgId: f.orgId, userId: f.targetId },
    }),
  ).toBe(1);
});
it("never recreates revoked access when an old grant is retried", async () => {
  const f = authenticated;
  const first = await grantMemberAccess({ data: f.input });
  await revokeMemberAccess({ data: { orgId: f.orgId, grantId: first.id } });
  expect(await grantMemberAccess({ data: f.input })).toMatchObject({
    id: first.id,
  });
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId, revokedAt: null },
    }),
  ).toBe(0);
});
it("recovers a committed revoke without affecting a later replacement", async () => {
  const f = authenticated;
  const first = await grantMemberAccess({ data: f.input });
  const revoke = {
    orgId: f.orgId,
    grantId: first.id,
    requestId: crypto.randomUUID(),
  };
  await revokeMemberAccess({ data: revoke });
  const replacement = await grantMemberAccess({
    data: { ...f.input, requestId: crypto.randomUUID() },
  });
  await expect(revokeMemberAccess({ data: revoke })).resolves.toMatchObject({
    ok: true,
  });
  expect(
    await getPrisma().memberPermissionGrant.findUniqueOrThrow({
      where: { id: replacement.id },
    }),
  ).toMatchObject({ revokedAt: null });
});
it("rejects a weekly draft reviewed for a previous duty week", async () => {
  const f = authenticated;
  await expect(
    grantMemberAccess({
      data: { ...f.input, expectedWeekStart: "2000-01-02" },
    }),
  ).rejects.toThrow("week");
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId },
    }),
  ).toBe(0);
});

it("admits concurrent exact grants once and rejects changed payloads on the same request", async () => {
  const f = authenticated;
  const [first, second] = await Promise.all([
    grantMemberAccess({ data: f.input }),
    grantMemberAccess({ data: f.input }),
  ]);
  expect(first.id).toBe(second.id);
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId },
    }),
  ).toBe(1);
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
  await expect(
    grantMemberAccess({ data: { ...f.input, reason: "Different intent" } }),
  ).rejects.toThrow("different access changes");
});

it("serializes competing requests for one capability without duplicate notifications", async () => {
  const f = authenticated;
  const results = await Promise.allSettled([
    grantMemberAccess({ data: f.input }),
    grantMemberAccess({ data: { ...f.input, requestId: crypto.randomUUID() } }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId },
    }),
  ).toBe(1);
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("rolls back a request receipt when its grant insert fails", async () => {
  const f = authenticated;
  await env.DB.prepare(
    "CREATE TRIGGER fixture_access_fail BEFORE INSERT ON member_permission_grant BEGIN SELECT RAISE(ABORT,'fixture insert unavailable'); END",
  ).run();
  try {
    await expect(grantMemberAccess({ data: f.input })).rejects.toThrow(
      "could not be confirmed",
    );
    expect(
      await env.DB.prepare("SELECT * FROM access_write_receipt WHERE orgId=?")
        .bind(f.orgId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_access_fail").run();
  }
  await expect(grantMemberAccess({ data: f.input })).resolves.toMatchObject({
    state: "active",
    notification: "created",
  });
});

async function makeOnDuty(f: Awaited<ReturnType<typeof fixture>>) {
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "member" },
  });
  const roleId = crypto.randomUUID(),
    assignmentId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO roster_role(id,orgId,code,name,short) VALUES(?,?,'tm','Technical manager','TM')",
  )
    .bind(roleId, f.orgId)
    .run();
  await env.DB.prepare(
    "INSERT INTO roster_assignment(id,orgId,weekStart,kind,roleId,userId) VALUES(?,?,?,'tech',?,?)",
  )
    .bind(assignmentId, f.orgId, f.authority.weekStart, roleId, f.userId)
    .run();
  return assignmentId;
}

it("preserves on-duty weekly scope, no-self-grant and the operational permission allowlist", async () => {
  const f = authenticated;
  const ongoing = await grantMemberAccess({
    data: { ...f.input, duration: "until-revoked" },
  });
  await makeOnDuty(f);
  await expect(
    grantMemberAccess({
      data: {
        ...f.input,
        requestId: crypto.randomUUID(),
        capability: "custom",
        permissions: ["settings:members"],
      },
    }),
  ).rejects.toThrow();
  await expect(
    grantMemberAccess({
      data: { ...f.input, requestId: crypto.randomUUID(), userId: f.userId },
    }),
  ).rejects.toThrow("another member");
  await expect(
    grantMemberAccess({
      data: {
        ...f.input,
        requestId: crypto.randomUUID(),
        duration: "until-revoked",
      },
    }),
  ).rejects.toThrow("current duty week");
  await expect(
    revokeMemberAccess({ data: { orgId: f.orgId, grantId: ongoing.id } }),
  ).rejects.toThrow("current duty week");
  const weekly = await grantMemberAccess({
    data: {
      ...f.input,
      requestId: crypto.randomUUID(),
      capability: "custom",
      permissions: ["rundown:view"],
    },
  });
  const stored = await getPrisma().memberPermissionGrant.findUniqueOrThrow({
    where: { id: weekly.id },
  });
  expect(stored).toMatchObject({
    startsOn: f.authority.weekStart,
    expiresOn: f.authority.weekEndExclusive,
    permissions: '["rundown:view"]',
  });
  const snapshot = await getAccessManagementSnapshotForActor({
    orgId: f.orgId,
    actorUserId: f.userId,
  });
  expect(
    snapshot.grants.find((grant) => grant.id === ongoing.id)?.canRevoke,
  ).toBe(false);
  expect(
    snapshot.grants.find((grant) => grant.id === weekly.id)?.canRevoke,
  ).toBe(true);
  await expect(
    revokeMemberAccess({ data: { orgId: f.orgId, grantId: weekly.id } }),
  ).resolves.toMatchObject({ state: "revoked" });
});

function raceBeforeCommit(work: () => Promise<unknown>) {
  let first = true;
  return {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (first) {
        first = false;
        await work();
      }
      return env.DB.batch<T>(statements);
    },
  };
}
it.each(["actor", "target", "session", "duty", "timezone"] as const)(
  "rejects a %s change at commit time",
  async (kind) => {
    const { writeAccessGrant } = await import("../access-write.server");
    const f = authenticated;
    const assignmentId = kind === "duty" ? await makeOnDuty(f) : null;
    const db = raceBeforeCommit(async () => {
      if (kind === "actor")
        return getPrisma().member.updateMany({
          where: { organizationId: f.orgId, userId: f.userId },
          data: { role: "member" },
        });
      if (kind === "target")
        return getPrisma().member.deleteMany({
          where: { organizationId: f.orgId, userId: f.targetId },
        });
      if (kind === "session")
        return getPrisma().session.deleteMany({ where: { userId: f.userId } });
      if (kind === "duty")
        return env.DB.prepare("DELETE FROM roster_assignment WHERE id=?")
          .bind(assignmentId)
          .run();
      return env.DB.prepare(
        "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'org-timezone','Pacific/Kiritimati') ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value",
      )
        .bind(crypto.randomUUID(), f.orgId)
        .run();
    });
    await expect(
      writeAccessGrant(db, f.actor, {
        ...f.input,
        kind: "grant",
        permissions: [],
      }),
    ).rejects.toThrow("changed");
    expect(
      await getPrisma().memberPermissionGrant.count({
        where: { orgId: f.orgId },
      }),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT * FROM access_write_receipt WHERE orgId=?")
        .bind(f.orgId)
        .first(),
    ).toBeNull();
  },
);

it("keeps notification failures pending without blocking revocation, then retries without stale notices", async () => {
  const f = authenticated;
  await env.DB.prepare(
    "CREATE TRIGGER fixture_access_notice_failure BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT,'fixture notices unavailable'); END",
  ).run();
  let grant;
  const removal = {
    orgId: f.orgId,
    grantId: "",
    requestId: crypto.randomUUID(),
  };
  try {
    grant = await grantMemberAccess({ data: f.input });
    expect(grant).toMatchObject({ state: "active", notification: "pending" });
    removal.grantId = grant.id;
    expect(await revokeMemberAccess({ data: removal })).toMatchObject({
      state: "revoked",
      notification: "pending",
    });
    expect(
      (
        await getAccessManagementSnapshotForActor({
          orgId: f.orgId,
          actorUserId: f.userId,
        })
      ).notices,
    ).toHaveLength(2);
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_access_notice_failure").run();
  }
  expect(
    await retryAccessGrantNotification({
      data: { orgId: f.orgId, requestId: f.input.requestId },
    }),
  ).toMatchObject({ state: "revoked", notification: "superseded" });
  expect(
    await retryAccessGrantNotification({
      data: { orgId: f.orgId, requestId: removal.requestId },
    }),
  ).toMatchObject({ state: "revoked", notification: "created" });
  await retryAccessGrantNotification({
    data: { orgId: f.orgId, requestId: removal.requestId },
  });
  expect(
    await getPrisma().notification.findMany({
      where: { orgId: f.orgId },
      select: { title: true, userId: true },
    }),
  ).toEqual([{ title: "Access revoked", userId: f.targetId }]);
  expect(
    (
      await getAccessManagementSnapshotForActor({
        orgId: f.orgId,
        actorUserId: f.userId,
      })
    ).notices,
  ).toHaveLength(0);
});

it("does not announce a late revocation after the member receives replacement access", async () => {
  const f = authenticated;
  const grant = await grantMemberAccess({ data: f.input });
  await env.DB.prepare(
    "CREATE TRIGGER fixture_access_notice_failure BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT,'fixture notices unavailable'); END",
  ).run();
  const removal = {
    orgId: f.orgId,
    grantId: grant.id,
    requestId: crypto.randomUUID(),
  };
  try {
    await revokeMemberAccess({ data: removal });
    await grantMemberAccess({
      data: { ...f.input, requestId: crypto.randomUUID() },
    });
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_access_notice_failure").run();
  }
  expect(
    await retryAccessGrantNotification({
      data: { orgId: f.orgId, requestId: removal.requestId },
    }),
  ).toMatchObject({ notification: "superseded" });
  expect(
    await getPrisma().notification.count({
      where: { orgId: f.orgId, title: "Access revoked" },
    }),
  ).toBe(0);
});

it("stores the reviewed capability and dates and refreshes relays after commit", async () => {
  const f = authenticated;
  const observed: unknown[] = [];
  effects.refresh.mockImplementation(async () => {
    observed.push(
      await getPrisma().memberPermissionGrant.findFirstOrThrow({
        where: { orgId: f.orgId },
      }),
    );
  });
  const grant = await grantMemberAccess({ data: f.input });
  expect(effects.refresh).toHaveBeenCalledWith(f.orgId, f.targetId);
  expect(observed).toEqual([
    expect.objectContaining({
      userId: f.targetId,
      capability: "rundown-operator",
      permissions: '["rundown:view","rundown:edit","rundown:control"]',
      startsOn: f.authority.weekStart,
      expiresOn: f.authority.weekEndExclusive,
      reason: f.input.reason,
      revokedAt: null,
    }),
  ]);
  await revokeMemberAccess({ data: { orgId: f.orgId, grantId: grant.id } });
  expect(observed).toHaveLength(2);
  expect(observed[1]).toMatchObject({
    id: grant.id,
    revokedAt: expect.any(Date),
  });
  expect(effects.refresh).toHaveBeenLastCalledWith(f.orgId, f.targetId);
});

it("converges exact revoke retries and rejects competing revokes without duplicate notices", async () => {
  const f = authenticated;
  const grant = await grantMemberAccess({ data: f.input });
  const data = {
    orgId: f.orgId,
    grantId: grant.id,
    requestId: crypto.randomUUID(),
  };
  const replies = await Promise.all([
    revokeMemberAccess({ data }),
    revokeMemberAccess({ data }),
  ]);
  expect(replies).toEqual([
    expect.objectContaining({ state: "revoked" }),
    expect.objectContaining({ state: "revoked" }),
  ]);
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(2);
  effects.refresh.mockClear();
  await expect(
    revokeMemberAccess({ data: { ...data, requestId: crypto.randomUUID() } }),
  ).rejects.toThrow("no longer active");
  expect(effects.refresh).not.toHaveBeenCalled();
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(2);
});

it.each(["expired", "missing"] as const)(
  "reports a %s saved grant without recreating access",
  async (state) => {
    const f = authenticated;
    const grant = await grantMemberAccess({ data: f.input });
    if (state === "missing")
      await getPrisma().memberPermissionGrant.delete({
        where: { id: grant.id },
      });
    else
      await getPrisma().memberPermissionGrant.update({
        where: { id: grant.id },
        data: { expiresOn: "2000-01-02" },
      });
    expect(await grantMemberAccess({ data: f.input })).toMatchObject({
      id: grant.id,
      state,
    });
    expect(
      await getPrisma().memberPermissionGrant.count({
        where: { orgId: f.orgId },
      }),
    ).toBe(state === "missing" ? 0 : 1);
    expect(
      await getPrisma().notification.count({ where: { orgId: f.orgId } }),
    ).toBe(1);
  },
);

it("rechecks current membership and session before recovering a receipt", async () => {
  const f = authenticated;
  await grantMemberAccess({ data: f.input });
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "member" },
  });
  await expect(grantMemberAccess({ data: f.input })).rejects.toThrow(
    "Only an Owner",
  );
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "owner" },
  });
  await getPrisma().session.deleteMany({ where: { userId: f.userId } });
  await expect(grantMemberAccess({ data: f.input })).rejects.toThrow("Sign in");
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("rolls back a failed revoke receipt and never refreshes access before commit", async () => {
  const f = authenticated;
  const grant = await grantMemberAccess({ data: f.input });
  const data = {
    orgId: f.orgId,
    grantId: grant.id,
    requestId: crypto.randomUUID(),
  };
  effects.refresh.mockClear();
  await env.DB.prepare(
    "CREATE TRIGGER fixture_access_revoke_fail BEFORE UPDATE OF revokedAt ON member_permission_grant BEGIN SELECT RAISE(ABORT,'fixture revoke unavailable'); END",
  ).run();
  try {
    await expect(revokeMemberAccess({ data })).rejects.toThrow(
      "could not be confirmed",
    );
    expect(effects.refresh).not.toHaveBeenCalled();
    expect(
      await getPrisma().memberPermissionGrant.findUniqueOrThrow({
        where: { id: grant.id },
      }),
    ).toMatchObject({ revokedAt: null });
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM access_write_receipt WHERE orgId=? AND requestId=?",
      )
        .bind(f.orgId, data.requestId)
        .first(),
    ).toBeNull();
    expect(
      await getPrisma().notification.count({ where: { orgId: f.orgId } }),
    ).toBe(1);
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_access_revoke_fail").run();
  }
  await expect(revokeMemberAccess({ data })).resolves.toMatchObject({
    state: "revoked",
  });
});

async function mobileAccess(path: string, orgId: string, body?: unknown) {
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/access${path}?orgId=${orgId}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing mobile access route");
  return response;
}

it("returns real mobile authority, members and capabilities with the web snapshot", async () => {
  const f = authenticated;
  const response = await mobileAccess("", f.orgId);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    authority: f.authority,
    currentUserId: f.userId,
    members: expect.arrayContaining([
      expect.objectContaining({ userId: f.targetId }),
    ]),
    grants: [],
    notices: [],
    capabilities: expect.arrayContaining([
      expect.objectContaining({ id: "rundown-operator" }),
    ]),
  });
});

it("recovers the same grant and revoke across web and native transports", async () => {
  const f = authenticated;
  const first = await grantMemberAccess({ data: f.input });
  const response = await mobileAccess("/grants", f.orgId, f.input);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ ...first, grantId: first.id });
  const data = {
    orgId: f.orgId,
    grantId: first.id,
    requestId: crypto.randomUUID(),
    expectedWeekStart: f.authority.weekStart,
  };
  const removal = await mobileAccess(
    `/grants/${first.id}/revoke`,
    f.orgId,
    data,
  );
  expect(removal.status).toBe(200);
  expect(await removal.json()).toMatchObject({
    id: first.id,
    state: "revoked",
    requestId: data.requestId,
  });
  await expect(revokeMemberAccess({ data })).resolves.toMatchObject({
    id: first.id,
    state: "revoked",
  });
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(2);
});

it.each([
  { capability: "become-owner" },
  { capability: "custom", permissions: ["settings:members"] },
  { requestId: "invalid-request" },
  { expectedWeekStart: "invalid-date" },
])(
  "rejects malformed mobile access commands before writing: %j",
  async (invalid) => {
    const f = authenticated;
    const response = await mobileAccess("/grants", f.orgId, {
      ...f.input,
      ...invalid,
    });
    expect(response.status).toBe(400);
    expect(
      await getPrisma().memberPermissionGrant.count({
        where: { orgId: f.orgId },
      }),
    ).toBe(0);
  },
);

it("rejects foreign targets, grants and mobile snapshots outside the caller's organization", async () => {
  const f = authenticated;
  const other = await seedRelayMember(crypto.randomUUID());
  await expect(
    grantMemberAccess({ data: { ...f.input, userId: other.userId } }),
  ).rejects.toThrow("not a member");
  const grant = await grantMemberAccess({ data: f.input });
  await getPrisma().member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: other.orgId,
      userId: f.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const wrongOrg = await mobileAccess(
    `/grants/${grant.id}/revoke`,
    other.orgId,
    { requestId: crypto.randomUUID() },
  );
  expect(wrongOrg.status).toBe(404);
  expect(
    await getPrisma().memberPermissionGrant.findUniqueOrThrow({
      where: { id: grant.id },
    }),
  ).toMatchObject({ revokedAt: null });
  await getPrisma().member.deleteMany({
    where: { organizationId: other.orgId, userId: f.userId },
  });
  expect((await mobileAccess("", other.orgId)).status).toBe(401);
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: other.orgId },
    }),
  ).toBe(0);
});

it("lets mobile retry only its actor's pending notification without regranting access", async () => {
  const f = authenticated;
  await env.DB.prepare(
    "CREATE TRIGGER fixture_access_mobile_notice BEFORE INSERT ON notification BEGIN SELECT RAISE(ABORT,'fixture notice offline'); END",
  ).run();
  let grant;
  try {
    grant = await grantMemberAccess({ data: f.input });
    expect(grant.notification).toBe("pending");
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_access_mobile_notice").run();
  }
  const request = { requestId: f.input.requestId };
  const response = await mobileAccess("/retry-notification", f.orgId, request);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: grant.id,
    notification: "created",
  });
  expect(
    (await mobileAccess("/retry-notification", f.orgId, request)).status,
  ).toBe(200);
  expect(
    await getPrisma().notification.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
  expect(
    await getPrisma().memberPermissionGrant.count({
      where: { orgId: f.orgId },
    }),
  ).toBe(1);
  await env.DB.prepare(
    "UPDATE access_write_receipt SET actorId=? WHERE orgId=? AND requestId=?",
  )
    .bind(f.targetId, f.orgId, request.requestId)
    .run();
  expect(
    (await mobileAccess("/retry-notification", f.orgId, request)).status,
  ).toBe(404);
});

it("bounds a hung relay refresh without blocking a committed revocation", async () => {
  const f = authenticated;
  const grant = await grantMemberAccess({ data: f.input });
  let release: (() => void) | undefined;
  effects.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    const result = await revokeMemberAccess({
      data: {
        orgId: f.orgId,
        grantId: grant.id,
        requestId: crypto.randomUUID(),
      },
    });
    expect(result).toMatchObject({ state: "revoked", notification: "created" });
    expect(
      await getPrisma().memberPermissionGrant.findUniqueOrThrow({
        where: { id: grant.id },
      }),
    ).toMatchObject({ revokedAt: expect.any(Date) });
  } finally {
    release?.();
  }
});
