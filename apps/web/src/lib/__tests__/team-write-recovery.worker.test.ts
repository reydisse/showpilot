import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import {
  getOrgMembers,
  updateMemberRole,
  removeMember,
  cancelInvitation,
} from "../session";
import { closeContentReport } from "../content-moderation";
const request = vi.hoisted(() => ({ cookie: "" }));
let requestAddress = 1;
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: request.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
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
afterEach(() => {
  request.cookie = "";
  vi.restoreAllMocks();
});
async function fixture() {
  const prisma = getPrisma(),
    userId = crypto.randomUUID(),
    orgId = crypto.randomUUID();
  const email = `${userId}@example.test`,
    password = "Team-fixture-password-92!";
  await prisma.user.create({
    data: { id: userId, name: "Team operator", email, emailVerified: true },
  });
  await prisma.account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Team fixture",
      slug: orgId,
      createdAt: new Date(),
    },
  });
  await prisma.member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const response = await SELF.fetch(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  request.cookie = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return { orgId, userId, cookie: request.cookie };
}
let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  authenticated = await fixture();
});

async function member(role = "member") {
  const userId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    email = `${userId}@example.test`;
  await getPrisma().user.create({
    data: { id: userId, name: "Fixture teammate", email, emailVerified: true },
  });
  await getPrisma().member.create({
    data: {
      id,
      userId,
      organizationId: authenticated.orgId,
      role,
      createdAt: new Date(),
    },
  });
  return { id, userId, email };
}
async function post(
  path: string,
  body: unknown,
  requestId = crypto.randomUUID(),
) {
  const response = await SELF.fetch(
    new Request(`https://app.showpilot.tech/api/auth/organization/${path}`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": `198.51.100.${requestAddress++}`,
        Cookie: request.cookie,
        Origin: "https://app.showpilot.tech",
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: JSON.stringify(body),
    }),
  );
  const result: unknown = await response.json();
  return { status: response.status, result };
}

it("replays a role command without overwriting a later role", async () => {
  const target = await member(),
    body = {
      organizationId: authenticated.orgId,
      memberId: target.id,
      role: "tm",
    },
    id = crypto.randomUUID();
  expect((await post("update-member-role", body, id)).status).toBe(200);
  expect(
    (await post("update-member-role", { ...body, role: "pm" })).status,
  ).toBe(200);
  expect((await post("update-member-role", body, id)).status).toBe(200);
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("pm");
});

it("does not remove a new membership when an old email-based removal is retried", async () => {
  const target = await member(),
    body = {
      organizationId: authenticated.orgId,
      memberIdOrEmail: target.email,
    },
    id = crypto.randomUUID();
  expect((await post("remove-member", body, id)).status).toBe(200);
  const replacement = crypto.randomUUID();
  await getPrisma().member.create({
    data: {
      id: replacement,
      userId: target.userId,
      organizationId: authenticated.orgId,
      role: "member",
      createdAt: new Date(),
    },
  });
  expect((await post("remove-member", body, id)).status).toBe(200);
  expect(
    await getPrisma().member.findUnique({ where: { id: replacement } }),
  ).not.toBeNull();
});

it("does not cancel an invitation that the recipient already accepted", async () => {
  const target = await member(),
    id = crypto.randomUUID();
  await getPrisma().invitation.create({
    data: {
      id,
      organizationId: authenticated.orgId,
      inviterId: authenticated.userId,
      email: target.email,
      role: "member",
      status: "accepted",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  expect((await post("cancel-invitation", { invitationId: id })).status).toBe(
    409,
  );
  expect(
    (await getPrisma().invitation.findUnique({ where: { id } }))?.status,
  ).toBe("accepted");
});

it("reports a conflicting moderation decision instead of returning false success", async () => {
  const reportId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO content_report(id,orgId,reporterUserId,targetType,targetId,reason,details,status) VALUES(?,?,?,'chat-message','fixture-message','other','','dismissed')",
  )
    .bind(reportId, authenticated.orgId, authenticated.userId)
    .run();
  await expect(
    closeContentReport({
      data: { orgId: authenticated.orgId, reportId, status: "resolved" },
    }),
  ).rejects.toThrow(/already|changed|review/);
});

it("exposes role revisions and preserves the exact request through web RPCs", async () => {
  const target = await member();
  const before = (
    await getOrgMembers({ data: { orgId: authenticated.orgId } })
  ).find((row) => row.id === target.id);
  expect(before).toMatchObject({
    managementRevision: 0,
    role: "member",
    user: { id: target.userId },
  });
  const data = {
    orgId: authenticated.orgId,
    memberId: target.id,
    role: "tm",
    expectedRevision: 0,
    requestId: crypto.randomUUID(),
  };
  await updateMemberRole({ data });
  await updateMemberRole({
    data: {
      ...data,
      role: "pm",
      expectedRevision: 1,
      requestId: crypto.randomUUID(),
    },
  });
  await updateMemberRole({ data });
  expect(
    (await getOrgMembers({ data: { orgId: authenticated.orgId } })).find(
      (row) => row.id === target.id,
    ),
  ).toMatchObject({ role: "pm", managementRevision: 2 });
  await expect(
    updateMemberRole({ data: { ...data, requestId: crypto.randomUUID() } }),
  ).rejects.toThrow(/changed|refresh/i);
});

it("web removal replays after the target is gone and rejects changed request contents", async () => {
  const target = await member(),
    replacement = await member();
  const data = {
    orgId: authenticated.orgId,
    memberIdOrEmail: target.id,
    expectedRevision: 0,
    requestId: crypto.randomUUID(),
  };
  await removeMember({ data });
  await removeMember({ data });
  await expect(
    removeMember({ data: { ...data, memberIdOrEmail: replacement.id } }),
  ).rejects.toThrow(/different/i);
  expect(
    await getPrisma().member.findUnique({ where: { id: replacement.id } }),
  ).not.toBeNull();
});

it("web cancellation is retryable and rejects a recipient decision", async () => {
  const id = crypto.randomUUID();
  await getPrisma().invitation.create({
    data: {
      id,
      organizationId: authenticated.orgId,
      inviterId: authenticated.userId,
      email: "invited@example.test",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const data = { invitationId: id, requestId: crypto.randomUUID() };
  await cancelInvitation({ data });
  await cancelInvitation({ data });
  expect(
    (await getPrisma().invitation.findUnique({ where: { id } }))?.status,
  ).toBe("canceled");
  await getPrisma().invitation.update({
    where: { id },
    data: { status: "rejected" },
  });
  await expect(
    cancelInvitation({ data: { ...data, requestId: crypto.randomUUID() } }),
  ).rejects.toThrow(/response/i);
});

it("retains at least one owner under simultaneous demotions", async () => {
  const other = await member("owner");
  const owner = await getPrisma().member.findFirstOrThrow({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
  });
  const outcomes = await Promise.all(
    [owner.id, other.id].map((memberId) =>
      post("update-member-role", {
        organizationId: authenticated.orgId,
        memberId,
        role: "admin",
      }),
    ),
  );
  expect(outcomes.filter((result) => result.status === 200)).toHaveLength(1);
  expect(
    outcomes.filter((result) => [403, 409].includes(result.status)),
  ).toHaveLength(1);
  expect(
    await getPrisma().member.count({
      where: { organizationId: authenticated.orgId, role: "owner" },
    }),
  ).toBe(1);
});

it("prevents removing the last owner and never records a rejected command as complete", async () => {
  const owner = await getPrisma().member.findFirstOrThrow({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
  });
  const id = crypto.randomUUID();
  expect(
    (
      await post(
        "remove-member",
        { organizationId: authenticated.orgId, memberIdOrEmail: owner.id },
        id,
      )
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM team_command_receipt WHERE orgId=? AND requestId=?",
    )
      .bind(authenticated.orgId, id)
      .first(),
  ).toBeNull();
  expect(
    await getPrisma().member.findUnique({ where: { id: owner.id } }),
  ).not.toBeNull();
});

it("does not let an administrator grant ownership or change an owner's membership", async () => {
  const target = await member("owner"),
    ordinary = await member();
  await getPrisma().member.updateMany({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
    data: { role: "admin" },
  });
  for (const memberId of [target.id, ordinary.id]) {
    expect(
      (
        await post("update-member-role", {
          organizationId: authenticated.orgId,
          memberId,
          role: memberId === target.id ? "member" : "owner",
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await post("remove-member", {
        organizationId: authenticated.orgId,
        memberIdOrEmail: target.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post("update-member-role", {
        organizationId: authenticated.orgId,
        memberId: ordinary.id,
        role: "tm",
      })
    ).status,
  ).toBe(200);
});

it("honors dynamic permissions and multi-role actors without granting unrelated actions", async () => {
  const role = "team-editor",
    target = await member();
  await env.DB.prepare(
    "INSERT INTO organizationRole(id,organizationId,role,permission,createdAt) VALUES(?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      authenticated.orgId,
      role,
      JSON.stringify({ member: ["update"] }),
      Date.now(),
    )
    .run();
  await getPrisma().member.updateMany({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
    data: { role: `member,${role}` },
  });
  expect(
    (
      await post("update-member-role", {
        organizationId: authenticated.orgId,
        memberId: target.id,
        role,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("remove-member", {
        organizationId: authenticated.orgId,
        memberIdOrEmail: target.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post("update-member-role", {
        organizationId: authenticated.orgId,
        memberId: target.id,
        role: "unknown-role",
      })
    ).status,
  ).toBe(400);
});

it("does not replay a receipt after the actor loses their membership", async () => {
  const target = await member(),
    data = {
      organizationId: authenticated.orgId,
      memberId: target.id,
      role: "tm",
    },
    id = crypto.randomUUID();
  expect((await post("update-member-role", data, id)).status).toBe(200);
  await getPrisma().member.deleteMany({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
  });
  expect((await post("update-member-role", data, id)).status).toBe(403);
});

it("keeps foreign organization members and receipts out of scope", async () => {
  const target = await member(),
    foreignOrg = crypto.randomUUID();
  await getPrisma().organization.create({
    data: {
      id: foreignOrg,
      name: "Foreign team",
      slug: foreignOrg,
      createdAt: new Date(),
    },
  });
  await getPrisma().member.update({
    where: { id: target.id },
    data: { organizationId: foreignOrg },
  });
  expect(
    (
      await post("update-member-role", {
        organizationId: authenticated.orgId,
        memberId: target.id,
        role: "tm",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await post("remove-member", {
        organizationId: foreignOrg,
        memberIdOrEmail: target.id,
      })
    ).status,
  ).toBe(403);
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("member");
});

it("clears the current active organization when an authorized owner removes themselves", async () => {
  await member("owner");
  const self = await getPrisma().member.findFirstOrThrow({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
  });
  await getPrisma().session.updateMany({
    where: { userId: authenticated.userId },
    data: { activeOrganizationId: authenticated.orgId },
  });
  expect(
    (
      await post("remove-member", {
        organizationId: authenticated.orgId,
        memberIdOrEmail: self.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await getPrisma().session.findFirstOrThrow({
        where: { userId: authenticated.userId },
      })
    ).activeOrganizationId,
  ).toBeNull();
});

it("rolls back the receipt when a member write fails, then recovers with the same request", async () => {
  const target = await member(),
    id = crypto.randomUUID(),
    data = {
      organizationId: authenticated.orgId,
      memberId: target.id,
      role: "tm",
    };
  await env.DB.prepare(
    "CREATE TRIGGER fixture_team_write_failure BEFORE UPDATE OF role ON member BEGIN SELECT RAISE(ABORT,'fixture write unavailable'); END",
  ).run();
  try {
    expect((await post("update-member-role", data, id)).status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM team_command_receipt WHERE orgId=? AND requestId=?",
      )
        .bind(authenticated.orgId, id)
        .first(),
    ).toBeNull();
    expect(
      (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
    ).toBe("member");
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_team_write_failure").run();
  }
  expect((await post("update-member-role", data, id)).status).toBe(200);
});

it("rejects stale role revisions even after the role changes away and back", async () => {
  const target = await member();
  await getPrisma().member.update({
    where: { id: target.id },
    data: { role: "tm" },
  });
  await getPrisma().member.update({
    where: { id: target.id },
    data: { role: "member" },
  });
  await expect(
    updateMemberRole({
      data: {
        orgId: authenticated.orgId,
        memberId: target.id,
        role: "pm",
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      },
    }),
  ).rejects.toThrow(/changed/i);
  expect(
    (await getOrgMembers({ data: { orgId: authenticated.orgId } })).find(
      (row) => row.id === target.id,
    ),
  ).toMatchObject({ role: "member", managementRevision: 2 });
});

async function atCommit<T>(
  before: () => Promise<unknown>,
  task: (
    db: Pick<D1Database, "prepare" | "batch">,
    actor: { userId: string; sessionId: string },
  ) => Promise<T>,
) {
  const session = await getPrisma().session.findFirstOrThrow({
    where: { userId: authenticated.userId },
  });
  const db: Pick<D1Database, "prepare" | "batch"> = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async <R = unknown>(statements: D1PreparedStatement[]) => {
      await before();
      return env.DB.batch<R>(statements);
    },
  };
  return task(db, { userId: authenticated.userId, sessionId: session.id });
}

it("fences authority revocation between admission and the atomic write", async () => {
  const { executeTeamCommand } = await import("../team-command.server");
  const target = await member();
  await expect(
    atCommit(
      () =>
        getPrisma().member.updateMany({
          where: {
            organizationId: authenticated.orgId,
            userId: authenticated.userId,
          },
          data: { role: "member" },
        }),
      (db, actor) =>
        executeTeamCommand(db, actor, {
          kind: "remove",
          orgId: authenticated.orgId,
          memberIdOrEmail: target.id,
          requestId: crypto.randomUUID(),
        }),
    ),
  ).rejects.toThrow(/authority changed/i);
  expect(
    await getPrisma().member.findUnique({ where: { id: target.id } }),
  ).not.toBeNull();
});

it("fences a dynamic permission edit that races an authorized write", async () => {
  const { executeTeamCommand } = await import("../team-command.server");
  const target = await member(),
    roleId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO organizationRole(id,organizationId,role,permission,createdAt) VALUES(?,?,?,?,?)",
  )
    .bind(
      roleId,
      authenticated.orgId,
      "team-editor",
      JSON.stringify({ member: ["update"] }),
      Date.now(),
    )
    .run();
  await getPrisma().member.updateMany({
    where: {
      organizationId: authenticated.orgId,
      userId: authenticated.userId,
    },
    data: { role: "team-editor" },
  });
  await expect(
    atCommit(
      () =>
        env.DB.prepare(
          "UPDATE organizationRole SET permission='{}' WHERE organizationId=? AND id=?",
        )
          .bind(authenticated.orgId, roleId)
          .run(),
      (db, actor) =>
        executeTeamCommand(db, actor, {
          kind: "role",
          orgId: authenticated.orgId,
          memberId: target.id,
          role: "tm",
          requestId: crypto.randomUUID(),
        }),
    ),
  ).rejects.toThrow(/authority changed/i);
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("member");
});

it("checks session expiry at commit, not only when the command starts", async () => {
  const { executeTeamCommand } = await import("../team-command.server");
  const target = await member();
  await expect(
    atCommit(
      () =>
        getPrisma().session.updateMany({
          where: { userId: authenticated.userId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      (db, actor) =>
        executeTeamCommand(db, actor, {
          kind: "role",
          orgId: authenticated.orgId,
          memberId: target.id,
          role: "tm",
          requestId: crypto.randomUUID(),
        }),
    ),
  ).rejects.toThrow(/authority changed/i);
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("member");
});

it("preserves a newer target role when it changes between admission and commit", async () => {
  const { executeTeamCommand } = await import("../team-command.server");
  const target = await member();
  await expect(
    atCommit(
      () =>
        getPrisma().member.update({
          where: { id: target.id },
          data: { role: "pm" },
        }),
      (db, actor) =>
        executeTeamCommand(db, actor, {
          kind: "role",
          orgId: authenticated.orgId,
          memberId: target.id,
          role: "tm",
          expectedRevision: 0,
          requestId: crypto.randomUUID(),
        }),
    ),
  ).rejects.toThrow(/changed/i);
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("pm");
});

it("does not cancel an invitation accepted between admission and commit", async () => {
  const { executeTeamCommand } = await import("../team-command.server");
  const id = crypto.randomUUID();
  await getPrisma().invitation.create({
    data: {
      id,
      organizationId: authenticated.orgId,
      inviterId: authenticated.userId,
      email: "race@example.test",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await expect(
    atCommit(
      () =>
        getPrisma().invitation.update({
          where: { id },
          data: { status: "accepted" },
        }),
      (db, actor) =>
        executeTeamCommand(db, actor, {
          kind: "cancel",
          orgId: authenticated.orgId,
          invitationId: id,
          requestId: crypto.randomUUID(),
        }),
    ),
  ).rejects.toThrow(/changed/i);
  expect(
    (await getPrisma().invitation.findUnique({ where: { id } }))?.status,
  ).toBe("accepted");
});

it("keeps the first moderation decision and reviewer when competing decisions arrive", async () => {
  const reportId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO content_report(id,orgId,reporterUserId,targetType,targetId,reason,details,status) VALUES(?,?,?,'chat-message','fixture-message','other','','open')",
  )
    .bind(reportId, authenticated.orgId, authenticated.userId)
    .run();
  const data = {
    orgId: authenticated.orgId,
    reportId,
    status: "resolved" as const,
    requestId: crypto.randomUUID(),
  };
  await closeContentReport({ data });
  const first = await env.DB.prepare(
    "SELECT * FROM content_report WHERE orgId=? AND id=?",
  )
    .bind(authenticated.orgId, reportId)
    .first();
  await closeContentReport({ data });
  await expect(
    closeContentReport({
      data: { ...data, status: "dismissed", requestId: crypto.randomUUID() },
    }),
  ).rejects.toThrow(/different decision/i);
  expect(
    await env.DB.prepare("SELECT * FROM content_report WHERE orgId=? AND id=?")
      .bind(authenticated.orgId, reportId)
      .first(),
  ).toEqual(first);
});

async function mobile(
  path: string,
  body: unknown,
  id: string,
  revision?: number,
) {
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/${path}?orgId=${authenticated.orgId}`,
      {
        method: "POST",
        headers: {
          Cookie: request.cookie,
          Origin: "https://app.showpilot.tech",
          "Content-Type": "application/json",
          "Idempotency-Key": id,
          ...(revision === undefined
            ? {}
            : { "X-ShowPilot-Member-Revision": String(revision) }),
        },
        body: JSON.stringify(body),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Mobile team route was not handled");
  return response;
}

it("mobile retries share receipts and surface rejected writes as HTTP errors", async () => {
  const target = await member(),
    requestId = crypto.randomUUID();
  const update = (id: string, revision: number) =>
    mobile(`members/${target.id}/role`, { role: "tm" }, id, revision);
  const changed = await update(requestId, 0);
  expect(changed.status).toBe(200);
  await changed.arrayBuffer();
  await getPrisma().member.update({
    where: { id: target.id },
    data: { role: "pm" },
  });
  const replay = await update(requestId, 0);
  expect(replay.status).toBe(200);
  await replay.arrayBuffer();
  const rejected = await update(crypto.randomUUID(), 0);
  expect(rejected.status).toBe(409);
  await rejected.arrayBuffer();
  expect(
    (await getPrisma().member.findUnique({ where: { id: target.id } }))?.role,
  ).toBe("pm");
  const removeId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await mobile(
      `members/${target.id}/remove`,
      {},
      removeId,
      2,
    );
    expect(removed.status).toBe(200);
    await removed.arrayBuffer();
  }
});

it("mobile cancellation retries after cancellation and rejects another organization", async () => {
  const id = crypto.randomUUID();
  await getPrisma().invitation.create({
    data: {
      id,
      organizationId: authenticated.orgId,
      inviterId: authenticated.userId,
      email: "mobile@example.test",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const requestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await mobile(`invitations/${id}/cancel`, {}, requestId);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  const foreignOrg = crypto.randomUUID();
  await getPrisma().organization.create({
    data: {
      id: foreignOrg,
      name: "Foreign team",
      slug: foreignOrg,
      createdAt: new Date(),
    },
  });
  await getPrisma().invitation.update({
    where: { id },
    data: { organizationId: foreignOrg },
  });
  const rejected = await mobile(`invitations/${id}/cancel`, {}, requestId);
  expect(rejected.status).toBe(404);
  await rejected.arrayBuffer();
});
