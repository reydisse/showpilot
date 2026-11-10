import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { writeKioskTeam, getKioskTeams } from "../kiosk-admin";
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

const teamCommand = () => ({
  orgId: authenticated.orgId,
  requestId: crypto.randomUUID(),
  action: "create" as const,
  name: "Audio",
  color: "#3b82f6",
});
const read = () => getKioskTeams({ data: { orgId: authenticated.orgId } });
const current = async (id: string) => {
  const team = (await read()).find((team) => team.id === id);
  if (!team) throw new Error("Fixture team missing");
  return {
    id,
    revision: team.revision,
    orgId: authenticated.orgId,
    requestId: crypto.randomUUID(),
  };
};
it("recovers a lost create reply without adding a second org-chart team", async () => {
  const data = teamCommand(),
    first = await writeKioskTeam({ data }),
    replay = await writeKioskTeam({ data });
  expect(replay).toEqual(first);
  expect(await read()).toHaveLength(1);
});
it("rejects adding a user who does not belong to this organization", async () => {
  const { id } = await writeKioskTeam({ data: teamCommand() }),
    other = await seedRelayMember(crypto.randomUUID());
  await expect(
    writeKioskTeam({
      data: {
        ...(await current(id)),
        action: "set-member",
        userId: other.userId,
        role: "member",
      },
    }),
  ).resolves.toMatchObject({ outcome: "conflict" });
  expect((await read())[0].members).toEqual([]);
});
it("keeps the previous lead when a replacement write fails", async () => {
  const { orgId, userId } = authenticated,
    { id } = await writeKioskTeam({ data: teamCommand() });
  await writeKioskTeam({
    data: {
      ...(await current(id)),
      action: "set-member",
      userId,
      role: "lead",
    },
  });
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
  const data = {
    ...(await current(id)),
    action: "set-member" as const,
    userId: other.userId,
    role: "lead" as const,
  };
  await env.DB.exec(
    "CREATE TRIGGER fail_kiosk_team_member BEFORE INSERT ON team_member BEGIN SELECT RAISE(ABORT,'fixture member write failure'); END;",
  );
  try {
    await expect(writeKioskTeam({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_kiosk_team_member");
  }
  expect((await read())[0]).toMatchObject({
    revision: data.revision,
    members: [expect.objectContaining({ userId, role: "lead" })],
  });
  expect(
    await env.DB.prepare(
      "SELECT * FROM kiosk_team_command_receipt WHERE requestId=?",
    )
      .bind(data.requestId)
      .first(),
  ).toBeNull();
  await writeKioskTeam({ data });
  expect((await read())[0].members.find((m) => m.role === "lead")?.userId).toBe(
    other.userId,
  );
});
it("keeps team members when the final team delete fails", async () => {
  const { userId } = authenticated,
    { id } = await writeKioskTeam({ data: teamCommand() });
  await writeKioskTeam({
    data: {
      ...(await current(id)),
      action: "set-member",
      userId,
      role: "lead",
    },
  });
  const data = { ...(await current(id)), action: "delete" as const };
  await env.DB.exec(
    "CREATE TRIGGER fail_kiosk_team_delete BEFORE DELETE ON team BEGIN SELECT RAISE(ABORT,'fixture team delete failure'); END;",
  );
  try {
    await expect(writeKioskTeam({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_kiosk_team_delete");
  }
  expect((await read())[0].members).toEqual([
    expect.objectContaining({ userId, role: "lead" }),
  ]);
  await writeKioskTeam({ data });
  expect(await read()).toEqual([]);
  expect(
    await env.DB.prepare("SELECT * FROM team_member WHERE teamId=?")
      .bind(id)
      .all(),
  ).toMatchObject({ results: [] });
});
it("acknowledges a repeated successful team deletion", async () => {
  const { id } = await writeKioskTeam({ data: teamCommand() }),
    data = { ...(await current(id)), action: "delete" as const };
  const first = await writeKioskTeam({ data });
  expect(await writeKioskTeam({ data })).toEqual(first);
});
it("claims concurrent duplicates once and rejects changed payload reuse", async () => {
  const data = teamCommand(),
    results = await Promise.all([
      writeKioskTeam({ data }),
      writeKioskTeam({ data }),
    ]);
  expect(results[0]).toEqual(results[1]);
  expect(await read()).toHaveLength(1);
  await expect(
    writeKioskTeam({ data: { ...data, name: "Changed" } }),
  ).rejects.toThrow("different team command");
});
it("rejects stale edits and cannot repeat a role change after another edit", async () => {
  const { id } = await writeKioskTeam({ data: teamCommand() }),
    target = await current(id);
  const first = {
    ...target,
    action: "set-member" as const,
    userId: authenticated.userId,
    role: "lead" as const,
  };
  await writeKioskTeam({ data: first });
  expect(
    (
      await writeKioskTeam({
        data: {
          ...target,
          requestId: crypto.randomUUID(),
          action: "update",
          name: "Old",
          color: "#ff0000",
        },
      })
    ).outcome,
  ).toBe("conflict");
  await writeKioskTeam({
    data: {
      ...(await current(id)),
      action: "remove-member",
      userId: authenticated.userId,
    },
  });
  expect((await writeKioskTeam({ data: first })).outcome).toBe("applied");
  expect((await read())[0].members).toEqual([]);
  const newer = {
    ...(await current(id)),
    action: "update" as const,
    name: "New",
    color: "#ff0000",
  };
  const competing = {
    ...newer,
    requestId: crypto.randomUUID(),
    name: "Another",
  };
  const results = await Promise.all([
    writeKioskTeam({ data: newer }),
    writeKioskTeam({ data: competing }),
  ]);
  expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
});
it("scopes authority and receipts to the actor and organization", async () => {
  const own = authenticated,
    cookie = auth.cookie,
    other = await fixture();
  auth.cookie = cookie;
  await expect(
    writeKioskTeam({ data: { ...teamCommand(), orgId: other.orgId } }),
  ).rejects.toThrow("permission");
  const data = teamCommand();
  await writeKioskTeam({ data });
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(own.orgId, own.userId)
    .run();
  await expect(writeKioskTeam({ data })).rejects.toThrow("permission");
  await env.DB.prepare(
    "UPDATE member SET role='owner' WHERE organizationId=? AND userId=?",
  )
    .bind(own.orgId, own.userId)
    .run();
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(own.actor.sessionId)
    .run();
  await expect(writeKioskTeam({ data })).rejects.toThrow("Sign in");
});

it("checks current authority inside the mutation transaction", async () => {
  const { executeKioskTeamCommand } =
    await import("../kiosk-team-command.server");
  const data = teamCommand();
  await expect(
    executeKioskTeamCommand(data, authenticated.actor, {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        await env.DB.prepare(
          "UPDATE member SET role='tm',managementRevision=managementRevision+1 WHERE organizationId=? AND userId=?",
        )
          .bind(data.orgId, authenticated.userId)
          .run();
        return env.DB.batch(statements);
      },
    }),
  ).rejects.toThrow("access changed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM team WHERE orgId=?")
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM kiosk_team_command_receipt WHERE orgId=?",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 0 });
});
it("rejects a target who leaves the org before commit and permits acknowledgement after a later departure", async () => {
  const { executeKioskTeamCommand } =
    await import("../kiosk-team-command.server");
  const other = await seedRelayMember(crypto.randomUUID());
  const membership = {
    id: crypto.randomUUID(),
    organizationId: authenticated.orgId,
    userId: other.userId,
    role: "member",
    createdAt: new Date(),
  };
  await getPrisma().member.create({ data: membership });
  const { id } = await writeKioskTeam({ data: teamCommand() }),
    data = {
      ...(await current(id)),
      action: "set-member" as const,
      userId: other.userId,
      role: "lead" as const,
    };
  const rejected = await executeKioskTeamCommand(data, authenticated.actor, {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      await env.DB.prepare("DELETE FROM member WHERE id=?")
        .bind(membership.id)
        .run();
      return env.DB.batch(statements);
    },
  });
  expect(rejected.outcome).toBe("conflict");
  expect((await read())[0].members).toEqual([]);
  await getPrisma().member.create({ data: membership });
  const accepted = { ...data, requestId: crypto.randomUUID() };
  expect((await writeKioskTeam({ data: accepted })).outcome).toBe("applied");
  await env.DB.prepare("DELETE FROM member WHERE id=?")
    .bind(membership.id)
    .run();
  expect((await writeKioskTeam({ data: accepted })).outcome).toBe("applied");
  expect((await read())[0].members).toEqual([]);
});
it("keeps receipts isolated between actors and cascades them when the organization is deleted", async () => {
  const { executeKioskTeamCommand } =
    await import("../kiosk-team-command.server");
  const data = teamCommand(),
    own = authenticated,
    other = await fixture();
  await getPrisma().member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: own.orgId,
      userId: other.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const a = await executeKioskTeamCommand(data, own.actor),
    b = await executeKioskTeamCommand(data, other.actor);
  expect(a.id).not.toBe(b.id);
  await env.DB.prepare("DELETE FROM organization WHERE id=?")
    .bind(own.orgId)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM kiosk_team_command_receipt WHERE orgId=?",
    )
      .bind(own.orgId)
      .first(),
  ).toEqual({ n: 0 });
});
it("refuses writes during organization deletion and validates the command before writing", async () => {
  await expect(
    writeKioskTeam({ data: { ...teamCommand(), color: "x".repeat(31) } }),
  ).rejects.toThrow();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','fixture')",
  )
    .bind(crypto.randomUUID(), authenticated.orgId)
    .run();
  await expect(writeKioskTeam({ data: teamCommand() })).rejects.toThrow(
    "permission",
  );
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM team WHERE orgId=?")
      .bind(authenticated.orgId)
      .first(),
  ).toEqual({ n: 0 });
});

it("removes departed org members from the kiosk org-chart projection", async () => {
  const { getOrgStructure } = await import("../kiosk-api");
  const { id } = await writeKioskTeam({ data: teamCommand() }),
    other = await seedRelayMember(crypto.randomUUID());
  const membership = {
    id: crypto.randomUUID(),
    organizationId: authenticated.orgId,
    userId: other.userId,
    role: "member",
    createdAt: new Date(),
  };
  await getPrisma().member.create({ data: membership });
  await writeKioskTeam({
    data: {
      ...(await current(id)),
      action: "set-member",
      userId: other.userId,
      role: "lead",
    },
  });
  expect(
    (await getOrgStructure(authenticated.orgId, "https://fixture.invalid"))
      ?.teams[0].lead?.id,
  ).toBe(other.userId);
  await env.DB.prepare("DELETE FROM member WHERE id=?")
    .bind(membership.id)
    .run();
  expect(
    (await getOrgStructure(authenticated.orgId, "https://fixture.invalid"))
      ?.teams[0],
  ).toMatchObject({ lead: null, members: [] });
});

it("preserves existing CSS team colors on update", async () => {
  const { id } = await writeKioskTeam({
    data: { ...teamCommand(), color: "red" },
  });
  await writeKioskTeam({
    data: {
      ...(await current(id)),
      action: "update",
      name: "Renamed",
      color: "red",
    },
  });
  expect((await read())[0]).toMatchObject({ name: "Renamed", color: "red" });
});
