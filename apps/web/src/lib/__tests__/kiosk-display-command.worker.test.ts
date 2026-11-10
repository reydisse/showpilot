import { setKioskBlanked } from "../kiosk-display-command.server";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import {
  writeKioskDisplay,
  readKioskDisplaySnapshot,
  type KioskDisplayDatabase,
} from "../kiosk-display-command.server";
import { getKioskDisplay } from "../kiosk-api";
import { setKioskBlankState, getKioskBlankState } from "../kiosk-display";
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

it("does not re-blank restored displays when a lost acknowledgement is retried", async () => {
  const { orgId } = authenticated;
  const data = {
    orgId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    blanked: true,
  };
  await setKioskBlankState({ data });
  await setKioskBlanked(orgId, false);
  await setKioskBlankState({ data });
  expect((await getKioskBlankState({ data: { orgId } })).blanked).toBe(false);
});
it("rejects a stale reviewed display state after another controller acts", async () => {
  const { orgId } = authenticated;
  await setKioskBlanked(orgId, true);
  await setKioskBlanked(orgId, false);
  await setKioskBlankState({
    data: {
      orgId,
      requestId: crypto.randomUUID(),
      expectedRevision: null,
      blanked: true,
    },
  });
  expect((await getKioskBlankState({ data: { orgId } })).blanked).toBe(false);
});

const command = () => ({
  orgId: authenticated.orgId,
  requestId: crypto.randomUUID(),
  expectedRevision: null,
  blanked: true,
});
it("claims concurrent duplicate requests once and rejects a changed payload", async () => {
  const data = command();
  const replies = await Promise.all([
    setKioskBlankState({ data }),
    setKioskBlankState({ data }),
  ]);
  expect(replies[0]).toEqual(replies[1]);
  expect(replies[0].outcome).toBe("applied");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_setting WHERE orgId=? AND key LIKE 'kiosk-display-command:%'",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 1 });
  await expect(
    setKioskBlankState({ data: { ...data, blanked: false } }),
  ).rejects.toThrow("different kiosk display command");
});
it("allows only one of two competing commands reviewed at the same revision", async () => {
  const blank = command(),
    restore = { ...command(), blanked: false };
  const results = await Promise.all([
    setKioskBlankState({ data: blank }),
    setKioskBlankState({ data: restore }),
  ]);
  expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
  const winner = results[0].outcome === "applied" ? blank : restore;
  expect(
    (await getKioskBlankState({ data: { orgId: blank.orgId } })).blanked,
  ).toBe(winner.blanked);
});
it("recognizes changes away and back from Companion and retains the existing kiosk polling contract", async () => {
  const data = command();
  const first = await setKioskBlankState({ data });
  expect((await getKioskDisplay(data.orgId)).blanked).toBe(true);
  await setKioskBlanked(data.orgId, false);
  expect((await getKioskDisplay(data.orgId)).blanked).toBe(false);
  await setKioskBlanked(data.orgId, true);
  const replay = await setKioskBlankState({ data });
  expect(replay.outcome).toBe("superseded");
  expect(replay.snapshot.blanked).toBe(true);
  expect(replay.snapshot.revision).not.toBe(first.snapshot.revision);
  expect(Object.keys(await getKioskDisplay(data.orgId)).sort()).toEqual([
    "blanked",
    "updatedAt",
  ]);
});
it("rolls receipt, value and revision back together after storage failure", async () => {
  const data = command();
  await env.DB.exec(
    "CREATE TRIGGER fail_kiosk_revision BEFORE INSERT ON app_setting WHEN NEW.key='kiosk-blank-revision' BEGIN SELECT RAISE(ABORT,'fixture kiosk failure'); END;",
  );
  try {
    await expect(setKioskBlankState({ data })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fail_kiosk_revision");
  }
  expect(await getKioskBlankState({ data: { orgId: data.orgId } })).toEqual({
    blanked: false,
    revision: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_setting WHERE orgId=? AND key LIKE 'kiosk-display-command:%'",
    )
      .bind(data.orgId)
      .first(),
  ).toEqual({ n: 0 });
  expect((await setKioskBlankState({ data })).outcome).toBe("applied");
});
it("scopes request receipts to organization and actor and rejects cross-org access", async () => {
  const own = authenticated,
    cookie = auth.cookie,
    other = await fixture();
  auth.cookie = cookie;
  await expect(
    setKioskBlankState({ data: { ...command(), orgId: other.orgId } }),
  ).rejects.toThrow("permission");
  await getPrisma().member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: own.orgId,
      userId: other.userId,
      role: "owner",
      createdAt: new Date(),
    },
  });
  const data = command();
  const first = await setKioskBlankState({ data });
  const second = await writeKioskDisplay({
    command: {
      ...data,
      expectedRevision: first.snapshot.revision,
      blanked: false,
    },
    actor: other.actor,
  });
  expect(second.outcome).toBe("applied");
  expect((await setKioskBlankState({ data })).outcome).toBe("superseded");
  expect(await readKioskDisplaySnapshot(other.orgId)).toEqual({
    blanked: false,
    revision: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_setting WHERE orgId=? AND key LIKE 'kiosk-display-command:%'",
    )
      .bind(own.orgId)
      .first(),
  ).toEqual({ n: 2 });
});
it("rechecks authority on replay and at commit, and refuses a deleting organization", async () => {
  const data = command();
  const database: KioskDisplayDatabase = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=?")
        .bind(data.orgId)
        .run();
      return env.DB.batch(statements);
    },
  };
  await expect(
    writeKioskDisplay({ command: data, actor: authenticated.actor, database }),
  ).rejects.toThrow("access changed");
  expect(await readKioskDisplaySnapshot(data.orgId)).toEqual({
    blanked: false,
    revision: null,
  });
  await env.DB.prepare("UPDATE member SET role='owner' WHERE organizationId=?")
    .bind(data.orgId)
    .run();
  await setKioskBlankState({ data });
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','fixture')",
  )
    .bind(crypto.randomUUID(), data.orgId)
    .run();
  await expect(setKioskBlankState({ data })).rejects.toThrow("permission");
  await expect(
    getKioskBlankState({ data: { orgId: data.orgId } }),
  ).rejects.toThrow("permission");
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(setKioskBlankState({ data })).rejects.toThrow("Sign in");
});
it("does not mistake damaged saved state for restored displays", async () => {
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'kiosk_blanked','damaged')",
  )
    .bind(crypto.randomUUID(), authenticated.orgId)
    .run();
  await expect(
    getKioskBlankState({ data: { orgId: authenticated.orgId } }),
  ).rejects.toThrow("could not be read");
});
