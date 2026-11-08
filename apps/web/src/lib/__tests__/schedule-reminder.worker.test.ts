import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { sendScheduleReminders } from "../schedule-reminder";
import { handleMobileApi } from "../mobile-api.server";
import type { ScheduleReminderCommand } from "../schedule-reminder-contract";
import { beforeEach } from "vitest";
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

async function signedIn() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-provider-password-92!";
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
  const revision = async () =>
    (
      await env.DB.prepare(
        "SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider-revision'",
      )
        .bind(orgId)
        .first<{ value: string }>()
    )?.value ?? null;
  return {
    orgId,
    userId,
    revision,
    headers: new Headers({ Cookie: auth.cookie }),
  };
}

async function fixture() {
  const account = await signedIn();
  const serviceDate = new Date(Date.now() + 20 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const showId = crypto.randomUUID();
  await getPrisma().rundown.create({
    data: {
      id: showId,
      orgId: account.orgId,
      serviceDate,
      name: "Fixture show",
    },
  });
  async function assignment(name: string, email: string) {
    const crewId = crypto.randomUUID(),
      id = crypto.randomUUID();
    await getPrisma().crewMember.create({
      data: {
        id: crewId,
        orgId: account.orgId,
        memberId: crewId,
        name,
        email,
        role: "Audio",
      },
    });
    await getPrisma().serviceAssignment.create({
      data: {
        id,
        orgId: account.orgId,
        showId,
        serviceDate,
        role: "Audio",
        crewMemberId: crewId,
      },
    });
    return { id, crewId };
  }
  const first = await assignment(
    "Fixture operator",
    `${account.userId}@example.test`,
  );
  const second = await assignment("External crew", "external@example.test");
  const command: ScheduleReminderCommand = {
    orgId: account.orgId,
    userId: account.userId,
    requestId: crypto.randomUUID(),
    target: { kind: "show", id: showId },
  };
  return { ...account, command, first, second, assignment };
}

it("native reminder retries keep the same accepted emails and recipient set", async () => {
  const f = await fixture();
  const post = async () => {
    const response = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/schedule/services/${f.command.target.id}/remind?orgId=${f.orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: f.headers.get("cookie")!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requestId: f.command.requestId }),
        },
      ),
      { DB: env.DB },
    );
    if (!response) throw new Error("Missing native response");
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  };
  await post();
  expect(mail.send).toHaveBeenCalledTimes(2);
  await f.assignment("Added later", "later@example.test");
  await post();
  expect(mail.send).toHaveBeenCalledTimes(2);
});

async function nativeReminder(
  f: Awaited<ReturnType<typeof fixture>>,
  command = f.command,
  cookie = f.headers.get("cookie")!,
) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/schedule/reminders?orgId=${f.orgId}`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing native response");
  return { status: response.status, body: await response.json() };
}

it("native full results preserve partial delivery, recipients, and provider identity on retry", async () => {
  const f = await fixture();
  mail.send.mockImplementation(async (email: { to: string }) => {
    if (email.to === "external@example.test") throw new TypeError("Lost reply");
  });
  const first = await nativeReminder(f);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    orgId: f.orgId,
    userId: f.userId,
    requestId: f.command.requestId,
    items: expect.arrayContaining([
      expect.objectContaining({ email: "accepted", inAppDelivered: true }),
      expect.objectContaining({ email: "uncertain" }),
    ]),
  });
  const original = mail.send.mock.calls.find(
    ([email]) => email.to === "external@example.test",
  );
  await f.assignment("Added later", "later@example.test");
  mail.send.mockResolvedValue(undefined);
  const second = await nativeReminder(f);
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({
    items: [
      expect.objectContaining({ email: "accepted" }),
      expect.objectContaining({ email: "accepted" }),
    ],
  });
  expect(mail.send).toHaveBeenCalledTimes(3);
  expect(mail.send.mock.calls[2]).toEqual(original);
  await nativeReminder(f);
  expect(mail.send).toHaveBeenCalledTimes(3);
});

it("native reminders reject anonymous, mismatched actor/org, and revoked permission without sending", async () => {
  const f = await fixture();
  expect((await nativeReminder(f, f.command, "")).status).toBe(401);
  expect(
    (await nativeReminder(f, { ...f.command, userId: "other" })).status,
  ).toBe(403);
  expect(
    (await nativeReminder(f, { ...f.command, orgId: "other" })).status,
  ).toBe(400);
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  expect((await nativeReminder(f)).status).toBe(403);
  expect(mail.send).not.toHaveBeenCalled();
});

it("keeps a bulk target set fixed and never repeats an accepted email or app alert", async () => {
  const f = await fixture();
  mail.send.mockImplementation(async (email: { to: string }) => {
    if (email.to === "external@example.test") throw new TypeError("Lost reply");
  });
  const first = await sendScheduleReminders({ data: f.command });
  expect(first.items.map((item) => item.email).sort()).toEqual([
    "accepted",
    "uncertain",
  ]);
  const accepted = first.items.find((item) => item.email === "accepted");
  expect(accepted?.inAppDelivered).toBe(true);
  await env.DB.prepare(
    "UPDATE notification SET readAt='2026-11-08T00:00:00.000Z' WHERE orgId=? AND type='assignment'",
  )
    .bind(f.orgId)
    .run();
  await f.assignment("New later crew", "later@example.test");
  mail.send.mockResolvedValue(undefined);
  const replay = await sendScheduleReminders({ data: f.command });
  expect(replay.items).toHaveLength(2);
  expect(replay.items.every((item) => item.email === "accepted")).toBe(true);
  expect(mail.send).toHaveBeenCalledTimes(3);
  expect(
    mail.send.mock.calls.filter(
      ([email]) => email.to === `${f.userId}@example.test`,
    ),
  ).toHaveLength(1);
  const inbox = await env.DB.prepare(
    "SELECT readAt FROM notification WHERE orgId=? AND type='assignment'",
  )
    .bind(f.orgId)
    .all<{ readAt: string | null }>();
  expect(inbox.results).toHaveLength(1);
  expect(inbox.results[0].readAt).not.toBeNull();
  await env.DB.prepare(
    "UPDATE service_assignment SET status='confirmed' WHERE orgId=?",
  )
    .bind(f.orgId)
    .run();
  expect(
    (await sendScheduleReminders({ data: f.command })).items.every(
      (item) => item.email === "accepted",
    ),
  ).toBe(true);
  expect(mail.send).toHaveBeenCalledTimes(3);
});

it("rejects changing the selection of an existing request", async () => {
  const f = await fixture();
  await sendScheduleReminders({ data: f.command });
  await expect(
    sendScheduleReminders({
      data: { ...f.command, target: { kind: "assignment", id: f.first.id } },
    }),
  ).rejects.toThrow("different selection");
  expect(mail.send).toHaveBeenCalledTimes(2);
});

it("does not send a retained request to a reassigned crew member", async () => {
  const f = await fixture();
  mail.send.mockRejectedValue(new TypeError("Lost reply"));
  const command = {
    ...f.command,
    target: { kind: "assignment" as const, id: f.first.id },
  };
  await sendScheduleReminders({ data: command });
  await env.DB.prepare(
    "UPDATE service_assignment SET crewMemberId=? WHERE orgId=? AND id=?",
  )
    .bind(f.second.crewId, f.orgId, f.first.id)
    .run();
  expect((await sendScheduleReminders({ data: command })).items[0].email).toBe(
    "changed",
  );
  expect(mail.send).toHaveBeenCalledTimes(1);
});

it("checks the current account and permission before retrying a stored request", async () => {
  const f = await fixture();
  mail.send.mockRejectedValue(new TypeError("Lost reply"));
  await sendScheduleReminders({ data: f.command });
  await expect(
    sendScheduleReminders({ data: { ...f.command, userId: "another-user" } }),
  ).rejects.toThrow("account changed");
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await expect(sendScheduleReminders({ data: f.command })).rejects.toThrow();
  expect(mail.send).toHaveBeenCalledTimes(2);
});

it("does not include another organization's selection", async () => {
  const f = await fixture(),
    other = await seedRelayMember(crypto.randomUUID());
  await expect(
    sendScheduleReminders({ data: { ...f.command, orgId: other.orgId } }),
  ).rejects.toThrow();
  expect(mail.send).not.toHaveBeenCalled();
});
