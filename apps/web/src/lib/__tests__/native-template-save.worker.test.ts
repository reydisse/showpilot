import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { handleMobileApi } from "../mobile-api.server";
import { createSavedRundown } from "../saved-rundown-create.server";
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
  const actor = await actorFixture();
  const showId = crypto.randomUUID(),
    requestId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name,location,updatedAt) VALUES (?,?,?,'Original','Main',?)",
  )
    .bind(showId, actor.orgId, "2026-11-08", "2026-01-01T00:00:00Z")
    .run();
  const call = async (method: string, path: string, body?: unknown) => {
    const reply = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/rundowns/${showId}/templates${path}?orgId=${actor.orgId}`,
        {
          method,
          headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      ),
      env,
    );
    if (!reply) throw new Error("Route not found");
    return reply;
  };
  return {
    ...actor,
    showId,
    requestId,
    save: (name = "Reviewed template", id = requestId) =>
      call("POST", "", { name, requestId: id }),
    remove: (body: unknown = {}) => call("POST", `/${requestId}/remove`, body),
    rows: async () =>
      (
        await env.DB.prepare(
          "SELECT key,value FROM app_setting WHERE orgId=? AND key LIKE 'rundown-%' ORDER BY key",
        )
          .bind(actor.orgId)
          .all<{ key: string; value: string }>()
      ).results,
  };
}
it("rejects changed template contents under a previously accepted request ID", async () => {
  const f = await fixture();
  expect((await f.save()).status).toBe(201);
  const before = await f.rows();
  expect((await f.save("Changed name")).status).toBe(409);
  expect(await f.rows()).toEqual(before);
});
it("does not recreate a removed template when the original mobile save arrives late", async () => {
  const f = await fixture();
  expect((await f.save()).status).toBe(201);
  expect((await f.remove()).status).toBe(200);
  const before = await f.rows();
  expect((await f.save()).status).toBe(409);
  expect(await f.rows()).toEqual(before);
  expect(
    (await f.rows()).some((row) => row.key.startsWith("rundown-saved:")),
  ).toBe(false);
});
it("uses the same immutable receipt as web saves", async () => {
  const f = await fixture();
  expect((await f.save()).status).toBe(201);
  const before = await f.rows();
  await expect(
    createSavedRundown(env.DB, f.orgId, {
      id: f.requestId,
      name: "Reviewed template",
      serviceName: "Original",
      scheduledStartTime: "",
      items: [],
    }),
  ).resolves.toEqual({ ok: true, id: f.requestId });
  expect(await f.rows()).toEqual(before);
});
it("replays an identical mobile save without changing either timestamp or receipt", async () => {
  const f = await fixture();
  expect((await f.save()).status).toBe(201);
  const before = await f.rows();
  const retry = await f.save();
  expect(retry.status).toBe(200);
  await expect(retry.json()).resolves.toEqual({
    ok: true,
    id: f.requestId,
    created: false,
  });
  expect(await f.rows()).toEqual(before);
});
it("does not silently replace a saved snapshot after the source show changes", async () => {
  const f = await fixture();
  expect((await f.save()).status).toBe(201);
  const before = await f.rows();
  await env.DB.prepare(
    "UPDATE rundown SET name='Changed live show' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  const reply = await f.save();
  expect(reply.status).toBe(409);
  expect(await f.rows()).toEqual(before);
});
it("allows only one name to win concurrent saves sharing a request ID", async () => {
  const f = await fixture();
  const replies = await Promise.all(
    Array.from({ length: 12 }, (_, index) => f.save(`Name ${index}`)),
  );
  expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
  expect(replies.filter((reply) => reply.status === 409)).toHaveLength(11);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  const template = JSON.parse(
    rows.find((row) => row.key.startsWith("rundown-saved:"))!.value,
  );
  expect(template.name).toBe(
    `Name ${replies.findIndex((reply) => reply.status === 201)}`,
  );
});
it("cannot resurrect a web-created template through a delayed installed mobile client", async () => {
  const f = await fixture();
  await createSavedRundown(env.DB, f.orgId, {
    id: f.requestId,
    name: "Reviewed template",
    serviceName: "Original",
    scheduledStartTime: "",
    items: [],
  });
  expect((await f.remove()).status).toBe(200);
  const before = await f.rows();
  expect((await f.save()).status).toBe(409);
  expect(await f.rows()).toEqual(before);
});
it("rolls back a mobile template if the common receipt cannot be stored", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER fail_native_template_receipt BEFORE INSERT ON app_setting WHEN NEW.key LIKE 'rundown-template-save:%' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END",
  );
  try {
    await expect(f.save()).rejects.toThrow("fixture receipt failure");
  } finally {
    await env.DB.exec("DROP TRIGGER fail_native_template_receipt");
  }
  expect(await f.rows()).toEqual([]);
  expect((await f.save()).status).toBe(201);
});
it("rejects an unsupported membership role before creating a template or receipt", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE member SET role='viewer' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  expect((await f.save()).status).toBe(401);
  expect(await f.rows()).toEqual([]);
});
it.each(["mobile", "web"])(
  "preserves deletion of a legacy template without an existing receipt through %s",
  async (client) => {
    const f = await fixture();
    const legacy = {
      id: f.requestId,
      name: "Reviewed template",
      serviceName: "Original",
      scheduledStartTime: "",
      items: [],
      createdAt: "2020-01-01",
      updatedAt: "2020-01-01",
    };
    await env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        f.orgId,
        `rundown-saved:${f.requestId}`,
        JSON.stringify(legacy),
      )
      .run();
    if (client === "mobile") expect((await f.remove()).status).toBe(200);
    else {
      const { deleteSavedRundown } = await import("../rundown");
      await expect(
        deleteSavedRundown({
          data: { orgId: f.orgId, rundownId: f.requestId },
        }),
      ).resolves.toEqual({ ok: true });
    }
    const afterDelete = await f.rows();
    expect((await f.save()).status).toBe(409);
    expect(await f.rows()).toEqual(afterDelete);
  },
);
it("correlates retained deletion replies and rejects a request from another account",async()=>{
  const f=await fixture();await f.save();
  const requestId=crypto.randomUUID(),before=await f.rows();
  const wrong=await f.remove({userId:"other-account",requestId});
  expect(wrong.status).toBe(403);await wrong.arrayBuffer();expect(await f.rows()).toEqual(before);
  const command={userId:f.userId,requestId};
  const first=await f.remove(command);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ok:true,orgId:f.orgId,userId:f.userId,showId:f.showId,templateId:f.requestId,requestId});
  const after=await f.rows();
  const replay=await f.remove(command);expect(replay.status).toBe(200);await replay.arrayBuffer();
  expect(await f.rows()).toEqual(after);
});
it("rejects malformed retained deletion identities before removing a template",async()=>{
  const f=await fixture();await f.save();const before=await f.rows();
  for(const body of [{requestId:"missing-user"},{userId:f.userId,requestId:42},{userId:f.userId,requestId:crypto.randomUUID(),extra:true}]){
    const response=await f.remove(body);expect(response.status).toBe(400);await response.arrayBuffer();
    expect(await f.rows()).toEqual(before);
  }
});
