import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import {
  getPersonalNotificationPreferences,
  updatePersonalNotificationPreference,
} from "../personal-notifications";
import {
  writeNotificationPreference,
  type NotificationPreferenceDatabase,
} from "../notification-preferences.server";
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

it("retries a lost reply without undoing a newer preference", async () => {
  const { orgId } = authenticated;
  const first = {
    orgId,
    category: "schedule" as const,
    deviceAlerts: false,
    requestId: crypto.randomUUID(),
    expectedDeviceAlerts: true,
  };
  expect(
    await updatePersonalNotificationPreference({ data: first }),
  ).toMatchObject({ outcome: "applied" });
  await updatePersonalNotificationPreference({
    data: {
      ...first,
      deviceAlerts: true,
      requestId: crypto.randomUUID(),
      expectedDeviceAlerts: false,
    },
  });
  expect(
    await updatePersonalNotificationPreference({ data: first }),
  ).toMatchObject({
    outcome: "superseded",
    preference: { deviceAlerts: true },
  });
  expect(
    (await getPersonalNotificationPreferences({ data: { orgId } })).find(
      (p) => p.category === "schedule",
    )?.deviceAlerts,
  ).toBe(true);
});

function command() {
  return {
    orgId: authenticated.orgId,
    category: "schedule" as const,
    deviceAlerts: false,
    expectedDeviceAlerts: true,
    requestId: crypto.randomUUID(),
  };
}
it("commits a concurrent replay once and rejects a reused ID with different intent", async () => {
  const input = command();
  const results = await Promise.all([
    updatePersonalNotificationPreference({ data: input }),
    updatePersonalNotificationPreference({ data: input }),
  ]);
  expect(results.map((r) => r.outcome)).toEqual(["applied", "applied"]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_preference_receipt WHERE orgId=?",
    )
      .bind(input.orgId)
      .first(),
  ).toEqual({ count: 1 });
  await expect(
    updatePersonalNotificationPreference({
      data: { ...input, category: "chat" },
    }),
  ).rejects.toThrow("different preference change");
  expect(
    await env.DB.prepare(
      "SELECT category FROM notification_preference WHERE orgId=?",
    )
      .bind(input.orgId)
      .all(),
  ).toMatchObject({ results: [{ category: "schedule" }] });
});
it("returns a reviewable conflict for an unseen choice and preserves that receipt", async () => {
  const input = { ...command(), expectedDeviceAlerts: false };
  expect(
    await updatePersonalNotificationPreference({ data: input }),
  ).toMatchObject({ outcome: "conflict", preference: { deviceAlerts: true } });
  expect(
    await env.DB.prepare("SELECT id FROM notification_preference WHERE orgId=?")
      .bind(input.orgId)
      .all(),
  ).toMatchObject({ results: [] });
  expect(
    await updatePersonalNotificationPreference({ data: input }),
  ).toMatchObject({ outcome: "conflict" });
  expect(
    await updatePersonalNotificationPreference({
      data: {
        ...input,
        requestId: crypto.randomUUID(),
        expectedDeviceAlerts: true,
      },
    }),
  ).toMatchObject({ outcome: "applied", preference: { deviceAlerts: false } });
});
it("rolls back the receipt if storing the preference fails, then recovers the same request", async () => {
  const input = command();
  await env.DB.exec(
    "CREATE TRIGGER reject_preference BEFORE INSERT ON notification_preference BEGIN SELECT RAISE(ABORT,'fixture preference failure'); END",
  );
  try {
    await expect(
      updatePersonalNotificationPreference({ data: input }),
    ).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER reject_preference");
  }
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM notification_preference_receipt WHERE orgId=?",
    )
      .bind(input.orgId)
      .all(),
  ).toMatchObject({ results: [] });
  expect(
    await updatePersonalNotificationPreference({ data: input }),
  ).toMatchObject({ outcome: "applied" });
});
it.each(["membership", "session"])(
  "rechecks %s at the transaction, even after authentication",
  async (kind) => {
    const f = authenticated;
    let changed = false;
    const database: NotificationPreferenceDatabase = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!changed) {
          changed = true;
          if (kind === "membership")
            await env.DB.prepare(
              "DELETE FROM member WHERE organizationId=? AND userId=?",
            )
              .bind(f.orgId, f.userId)
              .run();
          else
            await env.DB.prepare("DELETE FROM session WHERE id=?")
              .bind(f.actor.sessionId)
              .run();
        }
        const actual: NotificationPreferenceDatabase = env.DB;
        return actual.batch(statements);
      },
    };
    await expect(
      writeNotificationPreference({
        command: command(),
        actor: f.actor,
        database,
      }),
    ).rejects.toThrow("no longer active");
    expect(
      await env.DB.prepare(
        "SELECT requestId FROM notification_preference_receipt WHERE orgId=?",
      )
        .bind(f.orgId)
        .all(),
    ).toMatchObject({ results: [] });
  },
);
it("rejects unauthenticated and foreign-organization writes and malformed commands", async () => {
  const input = command();
  await expect(
    updatePersonalNotificationPreference({
      data: { ...input, orgId: "foreign" },
    }),
  ).rejects.toThrow();
  await expect(
    updatePersonalNotificationPreference({
      data: { ...input, requestId: "invalid" },
    }),
  ).rejects.toThrow();
  auth.cookie = "";
  await expect(
    updatePersonalNotificationPreference({ data: input }),
  ).rejects.toThrow("Sign in");
});
it("does not disclose a saved receipt after session expiry", async () => {
  const input = command();
  await updatePersonalNotificationPreference({ data: input });
  await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(
    writeNotificationPreference({ command: input, actor: authenticated.actor }),
  ).rejects.toThrow("no longer active");
});
it("isolates accounts with the same request ID and cascades private receipts on account deletion", async () => {
  const input = command();
  await updatePersonalNotificationPreference({ data: input });
  const second = await seedRelayMember(input.orgId, crypto.randomUUID());
  expect(
    await writeNotificationPreference({
      command: { ...input, category: "chat" },
      actor: second,
    }),
  ).toMatchObject({ outcome: "applied" });
  expect(
    await env.DB.prepare(
      "SELECT userId FROM notification_preference_receipt WHERE orgId=?",
    )
      .bind(input.orgId)
      .all(),
  ).toMatchObject({
    results: expect.arrayContaining([
      { userId: authenticated.userId },
      { userId: second.userId },
    ]),
  });
  await env.DB.prepare("DELETE FROM user WHERE id=?").bind(second.userId).run();
  expect(
    await env.DB.prepare(
      "SELECT userId FROM notification_preference_receipt WHERE orgId=?",
    )
      .bind(input.orgId)
      .all(),
  ).toMatchObject({ results: [{ userId: authenticated.userId }] });
});
async function mobile(body?: unknown) {
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/notification-preferences?orgId=${authenticated.orgId}`,
      {
        method: body ? "POST" : "GET",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing mobile preference route");
  return response;
}
it("shares receipts and current choices between native and web callers", async () => {
  const input = command();
  const first = await mobile(input);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    outcome: "applied",
    preference: { deviceAlerts: false },
    preferences: expect.arrayContaining([
      { category: "schedule", deviceAlerts: false },
    ]),
  });
  await updatePersonalNotificationPreference({
    data: {
      ...input,
      requestId: crypto.randomUUID(),
      expectedDeviceAlerts: false,
      deviceAlerts: true,
    },
  });
  const retry = await mobile(input);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({
    outcome: "superseded",
    preference: { deviceAlerts: true },
  });
  expect(await (await mobile()).json()).toMatchObject({
    preferences: expect.arrayContaining([
      { category: "schedule", deviceAlerts: true },
    ]),
  });
});
it("keeps legacy native writes working while validating new recovery fields", async () => {
  const input = command();
  expect(
    (
      await mobile({
        orgId: input.orgId,
        category: "reports",
        deviceAlerts: false,
      })
    ).status,
  ).toBe(200);
  expect((await mobile({ ...input, requestId: "bad" })).status).toBe(400);
  expect(
    (await mobile({ ...input, expectedDeviceAlerts: "false" })).status,
  ).toBe(400);
  expect((await mobile({ ...input, category: "foreign" })).status).toBe(400);
});
