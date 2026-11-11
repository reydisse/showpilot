import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { seedRelayMember } from "@/test/relay-fixtures";

vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
const origin = "https://app.showpilot.tech";
let address = 0;
async function fixture() {
  const { userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-sign-out-92!";
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
  async function login() {
    const response = await getAuth().handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "cf-connecting-ip": `192.0.2.${++address}`,
        },
        body: JSON.stringify({ email: `${userId}@example.test`, password }),
      }),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const current = await getAuth().api.getSession({
      headers: new Headers({ Cookie: cookie }),
      query: { disableCookieCache: true },
    });
    if (!current) throw new Error("Fixture login missing");
    return { cookie, sessionId: current.session.id };
  }
  return { userId, login, ...(await login()) };
}
async function signOut(
  cookie: string,
  expectedSessionId?: string,
  requestOrigin = origin,
) {
  return getAuth().handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: requestOrigin,
        Cookie: cookie,
      },
      body: JSON.stringify({ expectedSessionId }),
    }),
  );
}
async function stillSignedIn(cookie: string) {
  return getAuth().api.getSession({
    headers: new Headers({ Cookie: cookie }),
    query: { disableCookieCache: true },
  });
}

it("does not acknowledge sign-out or clear cookies when session deletion fails", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fixture_signout_failure BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT,'fixture session deletion failed'); END;",
  );
  try {
    const response = await signOut(f.cookie, f.sessionId);
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await stillSignedIn(f.cookie)).not.toBeNull();
  } finally {
    await env.DB.exec("DROP TRIGGER fixture_signout_failure;");
  }
  expect((await signOut(f.cookie, f.sessionId)).status).toBe(200);
  expect(await stillSignedIn(f.cookie)).toBeNull();
});

it("refuses an old confirmation against a newer sign-in", async () => {
  const f = await fixture();
  const newer = await f.login();
  expect(newer.sessionId).not.toBe(f.sessionId);
  const response = await signOut(newer.cookie, f.sessionId);
  expect(response.status).toBe(409);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await stillSignedIn(newer.cookie)).not.toBeNull();
});

it("makes duplicate and lost-response retries harmless without ending another device session", async () => {
  const f = await fixture(),
    other = await f.login();
  const first = await signOut(f.cookie, f.sessionId);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ success: true });
  expect((await signOut(f.cookie, f.sessionId)).status).toBe(200);
  expect(await stillSignedIn(f.cookie)).toBeNull();
  expect(await stillSignedIn(other.cookie)).not.toBeNull();
});

it("preserves legacy sign-out and rejects a foreign origin", async () => {
  const f = await fixture();
  expect(
    (await signOut(f.cookie, f.sessionId, "https://attacker.invalid")).status,
  ).toBe(403);
  expect(await stillSignedIn(f.cookie)).not.toBeNull();
  const response = await signOut(f.cookie);
  expect(response.status).toBe(200);
  expect(
    response.headers
      .getSetCookie()
      .some((cookie) => cookie.includes("Max-Age=0")),
  ).toBe(true);
  expect(await stillSignedIn(f.cookie)).toBeNull();
});
