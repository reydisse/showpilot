import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { writeScheduleProvider } from "../schedule-provider.server";
import type { ScheduleProviderCommand } from "../schedule-provider-contract";
import {
  getScheduleProvider,
  saveScheduleProvider,
} from "../schedule-provider";

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

function command(
  f: { orgId: string; userId: string },
  expectedRevision: string | null = null,
): ScheduleProviderCommand {
  return {
    orgId: f.orgId,
    userId: f.userId,
    requestId: crypto.randomUUID(),
    expectedRevision,
    config: {
      provider: "other",
      url: "https://old.example.test/schedule",
      label: "Earlier source",
    },
  };
}
const read = (orgId: string) => getScheduleProvider({ data: { orgId } });

it("does not replay an old scheduling source over a later save", async () => {
  const f = await fixture(),
    first = command(f);
  const initial = await saveScheduleProvider({ data: first });
  expect(initial.outcome).toBe("applied");
  const newer = await saveScheduleProvider({
    data: {
      ...command(f, initial.snapshot.revision),
      config: {
        provider: "other",
        url: "https://new.example.test/schedule",
        label: "Newer source",
      },
    },
  });
  const replay = await saveScheduleProvider({ data: first });
  expect(replay.outcome).toBe("superseded");
  expect(replay.snapshot).toEqual(newer.snapshot);
  expect((await read(f.orgId)).config.url).toBe(
    "https://new.example.test/schedule",
  );
});

it("keeps all fields, revision and receipt unchanged when one field fails, then safely retries", async () => {
  const f = await fixture();
  const initial = await saveScheduleProvider({
    data: {
      ...command(f),
      config: {
        provider: "planning-center",
        url: "https://old.example.test/schedule",
        label: "",
      },
    },
  });
  const next = command(f, initial.snapshot.revision);
  await env.DB.exec(
    "CREATE TRIGGER fixture_provider_failure BEFORE UPDATE ON app_setting WHEN NEW.key='schedule-provider-url' BEGIN SELECT RAISE(ABORT,'fixture provider failure'); END;",
  );
  try {
    await expect(saveScheduleProvider({ data: next })).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fixture_provider_failure;");
  }
  expect(await read(f.orgId)).toEqual(initial.snapshot);
  expect(
    await env.DB.prepare("SELECT 1 FROM app_setting WHERE orgId=? AND key=?")
      .bind(f.orgId, `schedule-provider-write:${f.userId}:${next.requestId}`)
      .first(),
  ).toBeNull();
  expect((await saveScheduleProvider({ data: next })).outcome).toBe("applied");
});

it("serializes concurrent commands, and requires a fresh request after a conflict", async () => {
  const f = await fixture(),
    a = command(f),
    b = command(f);
  b.config = {
    provider: "faithteams",
    url: "https://faith.example.test",
    label: "",
  };
  const results = await Promise.all([
    saveScheduleProvider({ data: a }),
    saveScheduleProvider({ data: b }),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "applied",
    "conflict",
  ]);
  const losing = results[0].outcome === "conflict" ? a : b;
  const saved = await read(f.orgId);
  expect((await saveScheduleProvider({ data: losing })).outcome).toBe(
    "conflict",
  );
  expect(await read(f.orgId)).toEqual(saved);
  expect(
    (
      await saveScheduleProvider({
        data: {
          ...losing,
          requestId: crypto.randomUUID(),
          expectedRevision: saved.revision,
        },
      })
    ).outcome,
  ).toBe("applied");
});

it("rejects reusing a receipt for a different payload", async () => {
  const f = await fixture(),
    first = command(f);
  const saved = await saveScheduleProvider({ data: first });
  await expect(
    saveScheduleProvider({
      data: { ...first, config: { provider: "native", url: "", label: "" } },
    }),
  ).rejects.toThrow("different scheduling source");
  expect(await read(f.orgId)).toEqual(saved.snapshot);
});

it("tracks legacy edits and deletion even when the visible configuration returns to its old value", async () => {
  const f = await fixture(),
    old = command(f);
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?)",
  )
    .bind(crypto.randomUUID(), f.orgId, "schedule-provider", "native")
    .run();
  await env.DB.prepare(
    "DELETE FROM app_setting WHERE orgId=? AND key='schedule-provider'",
  )
    .bind(f.orgId)
    .run();
  const afterDelete = await read(f.orgId);
  expect(afterDelete.config.provider).toBe("native");
  expect(afterDelete.revision).not.toBeNull();
  expect((await saveScheduleProvider({ data: old })).outcome).toBe("conflict");
  const applied = await saveScheduleProvider({
    data: command(f, afterDelete.revision),
  });
  await env.DB.prepare(
    "UPDATE app_setting SET value='https://different.example.test' WHERE orgId=? AND key='schedule-provider-url'",
  )
    .bind(f.orgId)
    .run();
  await env.DB.prepare(
    "UPDATE app_setting SET value=? WHERE orgId=? AND key='schedule-provider-url'",
  )
    .bind(applied.snapshot.config.url, f.orgId)
    .run();
  const aba = await read(f.orgId);
  expect(aba.config).toEqual(applied.snapshot.config);
  expect(aba.revision).not.toBe(applied.snapshot.revision);
  expect(
    (
      await saveScheduleProvider({
        data: command(f, applied.snapshot.revision),
      })
    ).outcome,
  ).toBe("conflict");
});

it.each(["session", "membership", "deleting"])(
  "checks %s authority at the write itself",
  async (revocation) => {
    const f = await fixture();
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async <T = Record<string, unknown>>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> => {
        if (revocation === "session")
          await env.DB.prepare("DELETE FROM session WHERE userId=?")
            .bind(f.userId)
            .run();
        if (revocation === "membership")
          await env.DB.prepare(
            "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
          )
            .bind(f.orgId, f.userId)
            .run();
        if (revocation === "deleting")
          await env.DB.prepare(
            "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
          )
            .bind(crypto.randomUUID(), f.orgId)
            .run();
        return env.DB.batch<T>(statements);
      },
    };
    await expect(
      writeScheduleProvider(f.headers, command(f), db),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM app_setting WHERE orgId=? AND key LIKE 'schedule-provider%'",
      )
        .bind(f.orgId)
        .first(),
    ).toBeNull();
  },
);

it("rejects another account, another organization and members without scheduling permission", async () => {
  const f = await fixture(),
    other = await seedRelayMember(crypto.randomUUID());
  await expect(
    saveScheduleProvider({ data: { ...command(f), userId: other.userId } }),
  ).rejects.toThrow();
  await expect(
    saveScheduleProvider({ data: { ...command(f), orgId: other.orgId } }),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=?")
    .bind(f.orgId)
    .run();
  await expect(read(f.orgId)).rejects.toThrow();
  await expect(saveScheduleProvider({ data: command(f) })).rejects.toThrow();
});

it.each(["http://example.test", "not a URL", "", "javascript:alert(1)"])(
  "rejects an invalid external URL: %s",
  async (url) => {
    const f = await fixture();
    await expect(
      saveScheduleProvider({
        data: { ...command(f), config: { provider: "other", url, label: "" } },
      }),
    ).rejects.toThrow();
    expect((await read(f.orgId)).revision).toBeNull();
  },
);

it("rejects the obsolete workspace terminology side effect", async () => {
  const f = await fixture();
  await expect(
    saveScheduleProvider({
      data: { ...command(f), terminologyProfile: "church" },
    }),
  ).rejects.toThrow();
  expect((await read(f.orgId)).revision).toBeNull();
});

it("allows organization deletion without a revision trigger resurrecting settings", async () => {
  const f = await fixture();
  await saveScheduleProvider({ data: command(f) });
  await env.DB.prepare("DELETE FROM organization WHERE id=?")
    .bind(f.orgId)
    .run();
  expect(
    await env.DB.prepare("SELECT 1 FROM app_setting WHERE orgId=?")
      .bind(f.orgId)
      .first(),
  ).toBeNull();
});
