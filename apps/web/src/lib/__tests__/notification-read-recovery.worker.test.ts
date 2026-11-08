import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import {
  getPersonalNotificationCount,
  markAllPersonalNotificationsRead,
  markPersonalNotificationRead,
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
  const insert = async (id = crypto.randomUUID()) => {
    await env.DB.prepare(
      `INSERT INTO notification (id,orgId,userId,type,severity,title,message,target,source,actionUrl,category,deviceAlertEnabled,dismissed,createdAt)
      VALUES (?,?,?,'test','info','Fixture alert','','','fixture','','system',0,0,'2026-11-08T00:00:00.000Z')`,
    )
      .bind(id, orgId, userId)
      .run();
    return id;
  };
  const readAt = (id: string) =>
    env.DB.prepare(
      "SELECT readAt FROM notification WHERE id=? AND orgId=? AND userId=?",
    )
      .bind(id, orgId, userId)
      .first<{ readAt: string | null }>();
  return {
    orgId,
    userId,
    insert,
    readAt,
    command: () => ({ orgId, requestId: crypto.randomUUID() }),
  };
}

it("retries mark-all without clearing a notification that arrived after the first commit", async () => {
  const f = await fixture();
  const old = await f.insert();
  const command = f.command();
  const first = await markAllPersonalNotificationsRead({ data: command });
  expect((await f.readAt(old))?.readAt).not.toBeNull();
  const later = await f.insert(); // Deliberately the same timestamp, so a date cutoff cannot fake this guarantee.
  const repeated = await markAllPersonalNotificationsRead({ data: command });
  expect((await f.readAt(later))?.readAt).toBeNull();
  expect(repeated).toEqual(first);
});

it("binds a request to its original notification", async () => {
  const f = await fixture();
  const first = await f.insert();
  const second = await f.insert();
  const command = { ...f.command(), id: first };
  await markPersonalNotificationRead({ data: command });
  await expect(
    markPersonalNotificationRead({ data: { ...command, id: second } }),
  ).rejects.toThrow(/different notification/i);
  expect((await f.readAt(second))?.readAt).toBeNull();
});

it("does not turn a single-notification retry into mark-all", async () => {
  const f = await fixture();
  const first = await f.insert();
  const second = await f.insert();
  const command = f.command();
  await markPersonalNotificationRead({ data: { ...command, id: first } });
  await expect(
    markAllPersonalNotificationsRead({ data: command }),
  ).rejects.toThrow(/different notification/i);
  expect((await f.readAt(second))?.readAt).toBeNull();
});

it("commits concurrent duplicate actions once and preserves prior read times", async () => {
  const f = await fixture();
  const id = await f.insert();
  const command = f.command();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      markAllPersonalNotificationsRead({ data: command }),
    ),
  );
  expect(results.every((result) => result.readAt === results[0].readAt)).toBe(
    true,
  );
  expect((await f.readAt(id))?.readAt).toBe(results[0].readAt);
  const receipt = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM notification_read_receipt WHERE orgId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .first<{ count: number }>();
  expect(receipt?.count).toBe(1);
  await markAllPersonalNotificationsRead({ data: f.command() });
  expect((await f.readAt(id))?.readAt).toBe(results[0].readAt);
});

it("rolls back the receipt if applying the read set fails", async () => {
  const f = await fixture();
  const id = await f.insert();
  const command = f.command();
  await env.DB.exec(
    "CREATE TRIGGER notification_test_failure BEFORE UPDATE OF readAt ON notification BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;",
  );
  try {
    await expect(
      markAllPersonalNotificationsRead({ data: command }),
    ).rejects.toThrow();
    expect((await f.readAt(id))?.readAt).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM notification_read_receipt WHERE orgId=? AND userId=? AND requestId=?",
      )
        .bind(f.orgId, f.userId, command.requestId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.exec("DROP TRIGGER notification_test_failure;");
  }
  await markAllPersonalNotificationsRead({ data: command });
  expect((await f.readAt(id))?.readAt).not.toBeNull();
});

it("rejects revoked membership on new actions and receipt replay", async () => {
  const f = await fixture();
  await f.insert();
  const command = f.command();
  await markAllPersonalNotificationsRead({ data: command });
  const later = await f.insert();
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(f.orgId, f.userId)
    .run();
  await expect(
    markAllPersonalNotificationsRead({ data: command }),
  ).rejects.toThrow(/membership/);
  await expect(
    markAllPersonalNotificationsRead({ data: f.command() }),
  ).rejects.toThrow(/membership/);
  expect((await f.readAt(later))?.readAt).toBeNull();
});

it("never marks another account or workspace's notifications", async () => {
  const other = await fixture();
  const otherId = await other.insert();
  const f = await fixture();
  const own = await f.insert();
  await markPersonalNotificationRead({ data: { ...f.command(), id: otherId } });
  await expect(
    markAllPersonalNotificationsRead({
      data: { ...f.command(), orgId: other.orgId },
    }),
  ).rejects.toThrow(/membership/);
  await env.DB.prepare(
    "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES (?,?,?,'member',CURRENT_TIMESTAMP)",
  )
    .bind(crypto.randomUUID(), other.orgId, f.userId)
    .run();
  await markAllPersonalNotificationsRead({
    data: { ...f.command(), orgId: other.orgId },
  });
  expect((await other.readAt(otherId))?.readAt).toBeNull();
  expect((await f.readAt(own))?.readAt).toBeNull();
});

it("rejects a revoked session and requires a request identity", async () => {
  const f = await fixture();
  const id = await f.insert();
  await expect(
    markAllPersonalNotificationsRead({
      data: { orgId: f.orgId, requestId: "invalid" },
    }),
  ).rejects.toThrow();
  await env.DB.prepare("DELETE FROM session WHERE userId=?")
    .bind(f.userId)
    .run();
  await expect(
    markAllPersonalNotificationsRead({ data: f.command() }),
  ).rejects.toThrow(/sign in/i);
  expect((await f.readAt(id))?.readAt).toBeNull();
});


it("counts only the signed-in member's unread, undismissed alerts in the requested workspace", async () => {
  const f = await fixture(); const cookie = auth.cookie;
  const unread = await f.insert(); const read = await f.insert(); const dismissed = await f.insert();
  await env.DB.prepare("UPDATE notification SET readAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=?").bind(f.orgId, read).run();
  await env.DB.prepare("UPDATE notification SET dismissed=1 WHERE orgId=? AND id=?").bind(f.orgId, dismissed).run();
  const other = await fixture(); await other.insert();
  auth.cookie = cookie;
  expect(await getPersonalNotificationCount({ data: { orgId: f.orgId } })).toEqual({ unread: 1 });
  await expect(getPersonalNotificationCount({ data: { orgId: other.orgId } })).rejects.toThrow(/forbidden/i);
  await markPersonalNotificationRead({ data: { ...f.command(), id: unread } });
  expect(await getPersonalNotificationCount({ data: { orgId: f.orgId } })).toEqual({ unread: 0 });
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.userId).run();
  await expect(getPersonalNotificationCount({ data: { orgId: f.orgId } })).rejects.toThrow(/forbidden/i);
});
