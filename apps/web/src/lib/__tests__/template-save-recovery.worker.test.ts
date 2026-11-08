import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { handleMobileApi } from "../mobile-api.server";
import { writeTemplateSave } from "../template-save-write.server";
import { templateSaveCommandSchema } from "../template-save-contract";
import { removeSavedRundown } from "../saved-rundown-delete.server";
afterEach(() => vi.restoreAllMocks());
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

async function actorFixture() {
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

async function fixture() {
  const actor = await actorFixture(),
    showId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name,location,updatedAt) VALUES (?,?,?,'Original','Main',?)",
  )
    .bind(showId, actor.orgId, "2026-11-08", "2026-01-01T00:00:00Z")
    .run();

  const command = templateSaveCommandSchema.parse({
    orgId: actor.orgId,
    userId: actor.userId,
    showId,
    requestId: crypto.randomUUID(),
    name: "Reviewed template",
    serviceName: "Reviewed source",
    scheduledStartTime: "09:30",
    items: [],
  });
  const call = async (
    review = false,
    input: unknown = command,
    pin?: string,
  ) => {
    const reply = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/rundowns/${showId}/templates/${review ? "review" : "command"}?orgId=${actor.orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: auth.cookie,
            "Content-Type": "application/json",
            ...(pin ? { "x-showpilot-rundown-pin": pin } : {}),
          },
          body: JSON.stringify(input),
        },
      ),
      env,
    );
    if (!reply) throw new Error("Missing route");
    return reply;
  };
  const result = async (review = false) => {
    const response = await call(review);
    expect(response.status).toBe(200);
    return response.json<{ outcome: string }>();
  };
  const rows = async () =>
    (
      await env.DB.prepare(
        "SELECT key,value FROM app_setting WHERE orgId=? AND key LIKE 'rundown-%' ORDER BY key",
      )
        .bind(actor.orgId)
        .all()
    ).results;
  const receipts = async () =>
    (
      await env.DB.prepare(
        "SELECT outcome FROM template_save_request WHERE orgId=?",
      )
        .bind(actor.orgId)
        .all<{ outcome: string }>()
    ).results;
  const session = await getAuth().api.getSession({
    headers: actor.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Missing session");
  return {
    ...actor,
    showId,
    command,
    call,
    result,
    rows,
    receipts,
    sessionId: session.session.id,
  };
}
it("saves the frozen copy and replays/reviews it after the source changes", async () => {
  const f = await fixture();
  expect((await f.result()).outcome).toBe("applied");
  const before = await f.rows();
  await env.DB.prepare(
    "UPDATE rundown SET name='Changed live show' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  expect((await f.result()).outcome).toBe("applied");
  expect((await f.result(true)).outcome).toBe("applied");
  expect(await f.rows()).toEqual(before);
  expect(await f.receipts()).toEqual([{ outcome: "applied" }]);
  expect(
    JSON.parse(
      String(
        before.find((row) => String(row.key).startsWith("rundown-saved:"))!
          .value,
      ),
    ).serviceName,
  ).toBe("Reviewed source");
});
it("review cancels an undelivered save and its late modern or legacy retry", async () => {
  const f = await fixture();
  expect((await f.result(true)).outcome).toBe("cancelled");
  expect((await f.result()).outcome).toBe("cancelled");
  const legacy = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/rundowns/${f.showId}/templates?orgId=${f.orgId}`,
      {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: f.command.requestId,
          name: f.command.name,
        }),
      },
    ),
    env,
  );
  expect(legacy!.status).toBe(409);
  expect(
    (await f.rows()).filter((row) =>
      String(row.key).startsWith("rundown-saved:"),
    ),
  ).toHaveLength(0);
});
it("a fresh ID can save after explicit cancellation", async () => {
  const f = await fixture();
  await f.result(true);
  const reply = await f.call(false, {
    ...f.command,
    requestId: crypto.randomUUID(),
  });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({ outcome: "applied" });
});
it("rejects changed content under the same request ID", async () => {
  const f = await fixture();
  await f.result();
  const before = await f.rows();
  expect(
    (await f.call(false, { ...f.command, name: "Different" })).status,
  ).toBe(409);
  expect(await f.rows()).toEqual(before);
});
it("reports removed after a confirmed copy was deleted without recreating it", async () => {
  const f = await fixture();
  await f.result();
  await removeSavedRundown(env.DB, f.orgId, f.command.requestId);
  const before = await f.rows();
  expect((await f.result()).outcome).toBe("removed");
  expect((await f.result(true)).outcome).toBe("removed");
  expect(await f.rows()).toEqual(before);
});
it("concurrent save and review agree on one durable outcome", async () => {
  const f = await fixture();
  const outcomes = await Promise.all([
    f.result(),
    f.result(true),
    f.result(),
    f.result(true),
  ]);
  expect(new Set(outcomes.map((r) => r.outcome)).size).toBe(1);
  expect(await f.receipts()).toHaveLength(1);
  expect(
    (await f.rows()).filter((row) =>
      String(row.key).startsWith("rundown-saved:"),
    ),
  ).toHaveLength(outcomes[0].outcome === "applied" ? 1 : 0);
});
it.each(["session", "role", "deleting"])(
  "checks %s authority at commit",
  async (change) => {
    const f = await fixture();
    await expect(
      writeTemplateSave(
        env.DB,
        f.command,
        { sessionId: f.sessionId, pin: null },
        "save",
        async () => {
          if (change === "session")
            await env.DB.prepare("DELETE FROM session WHERE userId=?")
              .bind(f.userId)
              .run();
          if (change === "role")
            await env.DB.prepare(
              "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
            )
              .bind(f.orgId, f.userId)
              .run();
          if (change === "deleting")
            await env.DB.prepare(
              "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
            )
              .bind(crypto.randomUUID(), f.orgId)
              .run();
        },
      ),
    ).rejects.toThrow("permission");
    expect(await f.receipts()).toEqual([]);
    expect(await f.rows()).toEqual([]);
  },
);
it("rolls back receipts and copy together if storage fails", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fail_modern_template BEFORE INSERT ON app_setting WHEN NEW.key LIKE 'rundown-saved:%' BEGIN SELECT RAISE(ABORT,'fixture template failure'); END",
  );
  try {
    await expect(f.call()).rejects.toThrow("fixture template failure");
  } finally {
    await env.DB.exec("DROP TRIGGER fail_modern_template");
  }
  expect(await f.receipts()).toEqual([]);
  expect(await f.rows()).toEqual([]);
  expect((await f.result()).outcome).toBe("applied");
});
it.each(["orgId", "userId", "showId"])(
  "rejects a mismatched %s",
  async (field) => {
    const f = await fixture();
    expect(
      (await f.call(false, { ...f.command, [field]: "different" })).status,
    ).toBe(403);
    expect(await f.receipts()).toEqual([]);
  },
);
it("reports conflict instead of adopting a legacy ID", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      f.orgId,
      `rundown-saved:${f.command.requestId}`,
      "legacy",
    )
    .run();
  const before = await f.rows();
  expect((await f.result()).outcome).toBe("conflict");
  expect(await f.rows()).toEqual(before);
});
it("records a removed source without creating a template", async () => {
  const f = await fixture();
  await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?")
    .bind(f.orgId, f.showId)
    .run();
  expect((await f.result()).outcome).toBe("removed");
  expect(await f.receipts()).toEqual([{ outcome: "removed" }]);
});

it("preserves technical-manager PIN access and rejects rotation at commit", async () => {
  const f = await fixture();
  const stored =
    "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
  )
    .bind(crypto.randomUUID(), f.orgId, stored)
    .run();
  expect((await f.call()).status).toBe(401);
  const saved = await f.call(false, f.command, "2468");
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ outcome: "applied" });
  const second = { ...f.command, requestId: crypto.randomUUID() };
  await expect(
    writeTemplateSave(
      env.DB,
      second,
      { sessionId: f.sessionId, pin: "2468" },
      "save",
      async () => {
        await env.DB.prepare(
          "UPDATE app_setting SET value='rotated' WHERE orgId=? AND key='rundown-pin'",
        )
          .bind(f.orgId)
          .run();
      },
    ),
  ).rejects.toThrow("permission");
  expect(await f.receipts()).toEqual([{ outcome: "applied" }]);
}, 30000);
it("can cancel an oversized database value without preparing the template insert", async () => {
  const f = await fixture();
  const oversized = {
    ...f.command,
    items: Array.from({ length: 150 }, (_, index) => ({
      id: `item-${index}`,
      title: "Item",
      type: "segment",
      duration: 1000,
      notes: "n".repeat(20000),
      assignee: "",
      cue: "",
      status: "upcoming",
      sortOrder: index,
      hardStop: false,
    })),
  };
  const cancelled = await f.call(true, oversized);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ outcome: "cancelled" });
  const late = await f.call(false, oversized);
  expect(late.status).toBe(200);
  expect(await late.json()).toMatchObject({ outcome: "cancelled" });
  expect(
    (await f.rows()).some((row) =>
      String(row.key).startsWith("rundown-saved:"),
    ),
  ).toBe(false);
});
