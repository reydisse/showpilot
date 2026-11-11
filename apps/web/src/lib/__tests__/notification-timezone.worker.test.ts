import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import {
  getPersonalNotificationTimeZone,
  savePersonalNotificationTimeZone,
} from "../personal-notifications";

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
  const password = "Disposable-notification-read-92!";
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
  return {
    orgId,
    userId,
    command: (timeZone: string, expectedRevision: number) => ({
      orgId,
      requestId: crypto.randomUUID(),
      timeZone,
      expectedRevision,
    }),
    saved: async () =>
      (
        await env.DB.prepare(
          "SELECT value FROM app_setting WHERE orgId=? AND key=?",
        )
          .bind(orgId, `notification-timezone:${userId}`)
          .first<{ value: string }>()
      )?.value ?? null,
  };
}

it("does not replay an old timezone over a newer device's save", async () => {
  const f = await fixture();
  const original = f.command("America/Toronto", 0);
  await savePersonalNotificationTimeZone({ data: original });
  await savePersonalNotificationTimeZone({
    data: f.command("Europe/London", 1),
  });
  await savePersonalNotificationTimeZone({ data: original });
  expect(await f.saved()).toBe("Europe/London");
});

it("rejects a stale timezone revision even after the stored value returns to its earlier value", async () => {
  const f = await fixture();
  await savePersonalNotificationTimeZone({
    data: f.command("America/Toronto", 0),
  });
  const stale = f.command("Asia/Tokyo", 1);
  await savePersonalNotificationTimeZone({
    data: f.command("Europe/London", 1),
  });
  await savePersonalNotificationTimeZone({
    data: f.command("America/Toronto", 2),
  });
  const result = await savePersonalNotificationTimeZone({ data: stale });
  expect(await f.saved()).toBe("America/Toronto");
  expect(result).toMatchObject({ outcome: "conflict" });
});

it("binds a timezone request to its original value and revision", async () => {
  const f = await fixture();
  const command = f.command("America/Toronto", 0);
  await savePersonalNotificationTimeZone({ data: command });
  await expect(
    savePersonalNotificationTimeZone({
      data: { ...command, timeZone: "Asia/Tokyo" },
    }),
  ).rejects.toThrow(/different timezone/i);
  expect(await f.saved()).toBe("America/Toronto");
});

it("accepts only one of two different device saves at the same revision", async () => {
  const f = await fixture();
  const results = await Promise.all(
    ["America/Toronto", "Europe/London"].map((zone) =>
      savePersonalNotificationTimeZone({ data: f.command(zone, 0) }),
    ),
  );
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "applied",
    "conflict",
  ]);
  const applied = results.find((result) => result.outcome === "applied");
  expect(
    await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }),
  ).toEqual(applied?.state);
  expect(applied?.state.revision).toBe(1);
});

it("commits a duplicate request once and reports a newer saved revision on replay", async () => {
  const f = await fixture();
  const command = f.command("America/Toronto", 0);
  expect(
    await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }),
  ).toEqual({ timeZone: null, revision: 0 });
  const replies = await Promise.all(
    Array.from({ length: 4 }, () =>
      savePersonalNotificationTimeZone({ data: command }),
    ),
  );
  expect(
    replies.every(
      (reply) => reply.outcome === "applied" && reply.state.revision === 1,
    ),
  ).toBe(true);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_timezone_receipt WHERE orgId=? AND userId=?",
      )
        .bind(f.orgId, f.userId)
        .first<{ count: number }>()
    )?.count,
  ).toBe(1);
  await savePersonalNotificationTimeZone({
    data: f.command("Europe/London", 1),
  });
  expect(
    await savePersonalNotificationTimeZone({ data: command }),
  ).toMatchObject({
    requestId: command.requestId,
    outcome: "superseded",
    state: { timeZone: "Europe/London", revision: 2 },
  });
});

it("tracks existing writers and retains revisions through deleting and recreating the preference", async () => {
  const f = await fixture();
  const key = `notification-timezone:${f.userId}`;
  await getPrisma().appSetting.create({
    data: { orgId: f.orgId, key, value: "America/Toronto" },
  });
  expect(
    await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }),
  ).toEqual({ timeZone: "America/Toronto", revision: 1 });
  await getPrisma().appSetting.update({
    where: { orgId_key: { orgId: f.orgId, key } },
    data: { value: "Europe/London" },
  });
  await getPrisma().appSetting.delete({
    where: { orgId_key: { orgId: f.orgId, key } },
  });
  expect(
    await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }),
  ).toEqual({ timeZone: null, revision: 3 });
  await getPrisma().appSetting.create({
    data: { orgId: f.orgId, key, value: "America/Toronto" },
  });
  expect(
    (
      await savePersonalNotificationTimeZone({
        data: f.command("Asia/Tokyo", 1),
      })
    ).outcome,
  ).toBe("conflict");
  expect(await f.saved()).toBe("America/Toronto");
  expect(
    (await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }))
      .revision,
  ).toBe(4);
});

it("rolls back the receipt and revision if storing the preference fails", async () => {
  const f = await fixture();
  const command = f.command("America/Toronto", 0);
  await env.DB.exec(
    "CREATE TRIGGER timezone_fixture_failure BEFORE INSERT ON app_setting WHEN substr(NEW.key,1,22)='notification-timezone:' BEGIN SELECT RAISE(ABORT,'fixture timezone write failure'); END;",
  );
  try {
    await expect(
      savePersonalNotificationTimeZone({ data: command }),
    ).rejects.toThrow();
    expect(await f.saved()).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM notification_timezone_receipt WHERE orgId=? AND userId=?",
      )
        .bind(f.orgId, f.userId)
        .first(),
    ).toBeNull();
    expect(
      (await getPersonalNotificationTimeZone({ data: { orgId: f.orgId } }))
        .revision,
    ).toBe(0);
  } finally {
    await env.DB.exec("DROP TRIGGER timezone_fixture_failure;");
  }
  expect(
    (await savePersonalNotificationTimeZone({ data: command })).outcome,
  ).toBe("applied");
});

it("scopes reads, writes and receipts to the current account and active membership", async () => {
  const first = await fixture();
  await savePersonalNotificationTimeZone({
    data: first.command("America/Toronto", 0),
  });
  const second = await fixture();
  await expect(
    getPersonalNotificationTimeZone({ data: { orgId: first.orgId } }),
  ).rejects.toThrow(/membership/);
  await expect(
    savePersonalNotificationTimeZone({
      data: first.command("Europe/London", 1),
    }),
  ).rejects.toThrow(/membership/);
  await env.DB.prepare(
    "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,'member',CURRENT_TIMESTAMP)",
  )
    .bind(crypto.randomUUID(), first.orgId, second.userId)
    .run();
  expect(
    await getPersonalNotificationTimeZone({ data: { orgId: first.orgId } }),
  ).toEqual({ timeZone: null, revision: 0 });
  const command = first.command("Asia/Tokyo", 0);
  await savePersonalNotificationTimeZone({ data: command });
  expect(await first.saved()).toBe("America/Toronto");
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(first.orgId, second.userId)
    .run();
  await expect(
    savePersonalNotificationTimeZone({ data: command }),
  ).rejects.toThrow(/membership/);
});

it("rejects invalid zones, actor spoofing and revoked sessions without storing a preference", async () => {
  const f = await fixture();
  await expect(
    savePersonalNotificationTimeZone({ data: f.command("Not/AZone", 0) }),
  ).rejects.toThrow();
  const spoofed = {
    ...f.command("America/Toronto", 0),
    userId: "another-account",
  };
  await expect(
    savePersonalNotificationTimeZone({ data: spoofed }),
  ).rejects.toThrow();
  await env.DB.prepare("DELETE FROM session WHERE userId=?")
    .bind(f.userId)
    .run();
  await expect(
    savePersonalNotificationTimeZone({ data: f.command("America/Toronto", 0) }),
  ).rejects.toThrow(/sign in/i);
  expect(await f.saved()).toBeNull();
});
