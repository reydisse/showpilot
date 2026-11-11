import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import {
  getFirstSessionChecklist,
  updateFirstSessionChecklist,
} from "../onboarding";
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
  const password = "Disposable-setup-password-92!";
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
  await getPrisma().appSetting.create({
    data: { orgId, key: "onboarding-started", value: new Date().toISOString() },
  });
  const read = () => getFirstSessionChecklist({ data: { orgId } });
  const item = (expectedSnapshot: string | null, completed: boolean) => ({
    orgId,
    requestId: crypto.randomUUID(),
    expectedSnapshot,
    action: { kind: "item" as const, item: "rename-item" as const, completed },
  });
  return { orgId, userId, read, item };
}

it("replays a saved completion without undoing a newer uncheck", async () => {
  const f = await fixture();
  const command = f.item(null, true);
  const first = await updateFirstSessionChecklist({ data: command });
  expect(first.outcome).toBe("applied");
  const newer = await updateFirstSessionChecklist({
    data: f.item(first.state.snapshot, false),
  });
  expect(newer.state.completed).toEqual([]);
  const replay = await updateFirstSessionChecklist({ data: command });
  expect(replay).toEqual({ ...first, state: newer.state });
  expect(await f.read()).toEqual(newer.state);
  await expect(
    updateFirstSessionChecklist({
      data: { ...command, action: { ...command.action, completed: false } },
    }),
  ).rejects.toThrow("different setting change");
});

it("requires review for concurrent edits and for changed-then-restored progress", async () => {
  const f = await fixture();
  const requests = [
    f.item(null, true),
    { ...f.item(null, false), action: { kind: "dismiss" as const } },
  ];
  const results = await Promise.all(
    requests.map((data) => updateFirstSessionChecklist({ data })),
  );
  expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
  const state = await f.read();
  expect(state.snapshot).not.toBeNull();
  const fresh = await updateFirstSessionChecklist({
    data: f.item(state.snapshot, false),
  });
  const stale = await updateFirstSessionChecklist({ data: f.item(null, true) });
  expect(stale.outcome).toBe("conflict");
  expect(await f.read()).toEqual(fresh.state);
});

it("rechecks membership and owner access before new writes and receipt replay", async () => {
  const f = await fixture();
  const command = f.item(null, true);
  await updateFirstSessionChecklist({ data: command });
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  expect(await f.read()).toEqual({
    show: false,
    completed: [],
    snapshot: null,
  });
  await expect(updateFirstSessionChecklist({ data: command })).rejects.toThrow(
    "owner",
  );
  const other = await seedRelayMember(crypto.randomUUID());
  await expect(
    updateFirstSessionChecklist({ data: { ...command, orgId: other.orgId } }),
  ).rejects.toThrow("Forbidden");
});

it("keeps personal progress separate and refuses unreadable saved data", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      f.orgId,
      "onboarding-first-session:someone-else",
      '{"dismissed":true,"completed":["open-board"]}',
    )
    .run();
  expect(await f.read()).toEqual({ show: true, completed: [], snapshot: null });
  await updateFirstSessionChecklist({ data: f.item(null, true) });
  expect(
    (
      await env.DB.prepare(
        "SELECT value FROM app_setting WHERE orgId=? AND key=?",
      )
        .bind(f.orgId, "onboarding-first-session:someone-else")
        .first<{ value: string }>()
    )?.value,
  ).toBe('{"dismissed":true,"completed":["open-board"]}');
  await env.DB.prepare(
    "UPDATE app_setting SET value='broken' WHERE orgId=? AND key=?",
  )
    .bind(f.orgId, `onboarding-first-session:${f.userId}`)
    .run();
  await expect(f.read()).rejects.toThrow("could not be read");
  await expect(
    updateFirstSessionChecklist({ data: f.item("broken", true) }),
  ).rejects.toThrow("could not be read");
});

it("rolls back the acknowledgement if saving progress fails", async () => {
  const f = await fixture();
  const key = `onboarding-first-session:${f.userId}`;
  await env.DB.prepare(
    `CREATE TRIGGER fail_first_session BEFORE INSERT ON app_setting WHEN NEW.orgId='${f.orgId}' AND NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'Fixture write failure'); END`,
  ).run();
  const command = f.item(null, true);
  try {
    await expect(
      updateFirstSessionChecklist({ data: command }),
    ).rejects.toThrow();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_first_session").run();
  }
  expect(
    (
      await env.DB.prepare(
        "SELECT key FROM app_setting WHERE orgId=? AND key LIKE 'setting-write:%'",
      )
        .bind(f.orgId)
        .all()
    ).results,
  ).toEqual([]);
  expect((await updateFirstSessionChecklist({ data: command })).outcome).toBe(
    "applied",
  );
});
