import { beforeEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { copyScheduleTeam } from "../schedule-copy";
import { runCopyScheduleTeam } from "../schedule-copy.server";
import { env } from "cloudflare:workers";

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../email", async (original) => ({
  ...(await original<typeof import("../email")>()),
  sendEmail: mail.send,
}));
beforeEach(() => {
  mail.send.mockReset().mockResolvedValue(undefined);
});

const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
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

async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-assignment-password-92!";
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
    .map((value) => value.split(";")[0])
    .join("; ");
  return { orgId, userId, headers: new Headers({ Cookie: auth.cookie }) };
}

async function assignmentFixture() {
  const actor = await fixture();
  const showId = crypto.randomUUID();
  const serviceDate = new Date(Date.now() + 20 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId: actor.orgId,
      serviceDate,
      name: "Assignment recovery fixture",
    },
  });
  return {
    ...actor,
    input: {
      showId,
      serviceDate,
      role: "Audio",
      department: "Production",
      crewMemberId: null,
      notes: "Original draft",
      callTime: "",
      timeZone: "UTC",
    },
  };
}

async function copyFixture() {
  const f = await assignmentFixture();
  const targetId = crypto.randomUUID();
  const targetDate = new Date(
    new Date(f.input.serviceDate).getTime() + 7 * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  await getPrisma().rundown.create({
    data: {
      id: targetId,
      orgId: f.orgId,
      serviceDate: targetDate,
      name: "Target show",
    },
  });
  const crew = await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: crypto.randomUUID(),
      name: "Fixture crew",
      email: "copy-recovery@example.test",
      role: "Audio",
    },
  });
  const source = await getPrisma().serviceAssignment.create({
    data: {
      orgId: f.orgId,
      showId: f.input.showId,
      serviceDate: f.input.serviceDate,
      crewMemberId: crew.id,
      role: "Audio",
    },
  });
  return {
    ...f,
    source,
    command: {
      orgId: f.orgId,
      userId: f.userId,
      requestId: crypto.randomUUID(),
      showId: targetId,
      serviceDate: targetDate,
      copyFromShowId: f.input.showId,
      copyFrom: f.input.serviceDate,
    },
  };
}
it("recovers the original copied roster even if the source roster gains another position", async () => {
  const f = await copyFixture();
  await copyScheduleTeam({ data: f.command });
  await getPrisma().serviceAssignment.create({
    data: {
      orgId: f.orgId,
      showId: f.input.showId,
      serviceDate: f.input.serviceDate,
      role: "Added later",
    },
  });
  await expect(copyScheduleTeam({ data: f.command })).resolves.toMatchObject({
    copied: 1,
  });
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(1);
});
it("retries an uncertain copied invitation with the original delivery key and body", async () => {
  const f = await copyFixture();
  mail.send.mockRejectedValueOnce(
    new TypeError("Provider accepted but reply lost"),
  );
  await copyScheduleTeam({ data: f.command });
  await copyScheduleTeam({ data: f.command });
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(mail.send.mock.calls[1][0]).toEqual(mail.send.mock.calls[0][0]);
  expect(mail.send.mock.calls[1][1]).toEqual(mail.send.mock.calls[0][1]);
});

it("coalesces concurrent copies and keeps a later new copy from replacing the target roster", async () => {
  const f = await copyFixture();
  const same = await Promise.all([
    copyScheduleTeam({ data: f.command }),
    copyScheduleTeam({ data: f.command }),
  ]);
  expect(same[0].items.map((row) => row.id)).toEqual(
    same[1].items.map((row) => row.id),
  );
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(1);
  expect(
    (
      await copyScheduleTeam({
        data: { ...f.command, requestId: crypto.randomUUID() },
      })
    ).reason,
  ).toBe("target-not-empty");
});
it("does not recopy a deleted target position or resend an old invitation", async () => {
  const f = await copyFixture();
  mail.send.mockRejectedValueOnce(new TypeError("Lost email reply"));
  const first = await copyScheduleTeam({ data: f.command });
  await getPrisma().serviceAssignment.delete({
    where: { id: first.items[0].id },
  });
  const retry = await copyScheduleTeam({ data: f.command });
  expect(retry.items[0]).toMatchObject({ changed: true, invitation: null });
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(0);
  expect(mail.send).toHaveBeenCalledTimes(1);
});
it("reports a changed target without overwriting the manager's changes", async () => {
  const f = await copyFixture(),
    first = await copyScheduleTeam({ data: f.command });
  await getPrisma().serviceAssignment.update({
    where: { id: first.items[0].id },
    data: {
      role: "Changed position",
      status: "confirmed",
      responseNote: "Confirmed later",
    },
  });
  const retry = await copyScheduleTeam({ data: f.command });
  expect(retry.items[0].changed).toBe(true);
  expect(
    await getPrisma().serviceAssignment.findUniqueOrThrow({
      where: { id: first.items[0].id },
    }),
  ).toMatchObject({
    role: "Changed position",
    status: "confirmed",
    responseNote: "Confirmed later",
  });
  expect(mail.send).toHaveBeenCalledTimes(1);
});
it("requires a fresh request after a live-show block and resets copied responses", async () => {
  const f = await copyFixture();
  await getPrisma().rundown.update({
    where: { id: f.command.showId },
    data: { status: "running" },
  });
  expect((await copyScheduleTeam({ data: f.command })).reason).toBe(
    "live-show",
  );
  await getPrisma().rundown.update({
    where: { id: f.command.showId },
    data: { status: "draft" },
  });
  expect((await copyScheduleTeam({ data: f.command })).reason).toBe(
    "live-show",
  );
  await getPrisma().serviceAssignment.update({
    where: { id: f.source.id },
    data: {
      status: "confirmed",
      responseNote: "Last week",
      notes: "Old manager note",
      callTime: "09:15",
      department: "Broadcast",
    },
  });
  const copied = await copyScheduleTeam({
    data: { ...f.command, requestId: crypto.randomUUID() },
  });
  expect(copied.reason).toBeNull();
  expect(
    await getPrisma().serviceAssignment.findUniqueOrThrow({
      where: { id: copied.items[0].id },
    }),
  ).toMatchObject({
    status: "assigned",
    responseNote: "",
    notes: "",
    callTime: "09:15",
    department: "Broadcast",
  });
});
it("rejects account, permission, organization and changed request-selection boundaries", async () => {
  const f = await copyFixture();
  await copyScheduleTeam({ data: f.command });
  await expect(
    runCopyScheduleTeam(f.headers, { ...f.command, userId: "other-user" }),
  ).rejects.toThrow("account");
  await expect(
    runCopyScheduleTeam(f.headers, {
      ...f.command,
      copyFromShowId: "different-source",
    }),
  ).rejects.toThrow("different show selection");
  const other = await copyFixture();
  expect(
    (
      await runCopyScheduleTeam(f.headers, {
        ...f.command,
        requestId: crypto.randomUUID(),
        copyFromShowId: other.command.copyFromShowId,
      })
    ).reason,
  ).toBe("show-missing");
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "member" },
  });
  await expect(runCopyScheduleTeam(f.headers, f.command)).rejects.toThrow(
    "permission",
  );
});
it("checks the target again inside the transaction and rolls back receipts on failure", async () => {
  const f = await copyFixture();
  const fails = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>([
        ...statements,
        env.DB.prepare("INSERT INTO copy_missing_table VALUES (1)"),
      ]),
  };
  await expect(
    runCopyScheduleTeam(f.headers, f.command, fails),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT * FROM schedule_copy_request WHERE orgId=?")
      .bind(f.orgId)
      .first(),
  ).toBeNull();
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(0);
  const changed = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().rundown.update({
        where: { id: f.command.showId },
        data: { status: "running" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  expect(
    (await runCopyScheduleTeam(f.headers, f.command, changed)).reason,
  ).toBe("live-show");
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(0);
});
it("does not create copied rows if permission is revoked before the batch", async () => {
  const f = await copyFixture();
  const revoked = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().member.updateMany({
        where: { organizationId: f.orgId, userId: f.userId },
        data: { role: "member" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    runCopyScheduleTeam(f.headers, f.command, revoked),
  ).rejects.toThrow("permission");
  expect(
    await getPrisma().serviceAssignment.count({
      where: { orgId: f.orgId, showId: f.command.showId },
    }),
  ).toBe(0);
  expect(mail.send).not.toHaveBeenCalled();
});
it("preserves open positions and reports an empty source without claiming a copy", async () => {
  const f = await copyFixture();
  await getPrisma().serviceAssignment.delete({ where: { id: f.source.id } });
  expect((await copyScheduleTeam({ data: f.command })).reason).toBe(
    "source-empty",
  );
  await getPrisma().serviceAssignment.create({
    data: {
      orgId: f.orgId,
      showId: f.input.showId,
      serviceDate: f.input.serviceDate,
      role: "Open camera",
    },
  });
  const copied = await copyScheduleTeam({
    data: { ...f.command, requestId: crypto.randomUUID() },
  });
  expect(copied.copied).toBe(1);
  expect(copied.items[0].invitation).toBeNull();
  expect(mail.send).not.toHaveBeenCalled();
});
