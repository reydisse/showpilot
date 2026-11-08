import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { getTmGraphicsState, writeTmGraphicsClear } from "../tm-graphics";
import { clearTmGraphics } from "../tm-graphics.server";
import { publishGraphicComposition, getActiveGraphics } from "../graphics";
import { triggerLowerThirdForOrg, readLowerThirdForOrg } from "../lowerthirds";
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

beforeEach(async () => {
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?")
    .bind(authenticated.orgId)
    .run();
});
it("clears the Program graphics published from the Graphics page", async () => {
  const { orgId } = authenticated;
  await publishGraphicComposition({
    data: {
      orgId,
      requestId: crypto.randomUUID(),
      items: [
        {
          key: "fixture",
          name: "Fixture title",
          title: "Program title",
          subtitle: "",
          style: "{}",
        },
      ],
    },
  });
  expect(await getActiveGraphics({ data: { orgId } })).toHaveLength(1);
  await writeTmGraphicsClear({ data: await command() });
  expect(await getActiveGraphics({ data: { orgId } })).toEqual([]);
});
it("does not clear a newer lower third when the previous Clear reply is retried", async () => {
  const { orgId } = authenticated;
  await triggerLowerThirdForOrg(orgId, {
    id: "first",
    type: "freetext",
    line1: "First lower third",
    style: "default",
  });
  const data = await command();
  await writeTmGraphicsClear({ data });
  await triggerLowerThirdForOrg(orgId, {
    id: "newer",
    type: "freetext",
    line1: "Newer lower third",
    style: "default",
  });
  await writeTmGraphicsClear({ data });
  expect((await readLowerThirdForOrg(orgId))?.id).toBe("newer");
});
it("reviews and clears the overlay's legacy graphic when its multi-graphic list is empty", async () => {
  const { orgId } = authenticated;
  await publish("Legacy Program");
  const [graphic] = await getActiveGraphics({ data: { orgId } });
  await env.DB.batch([
    env.DB.prepare("UPDATE app_setting SET value='[]' WHERE orgId=? AND key='active-graphics'").bind(orgId),
    env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-graphic',?) ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value").bind(crypto.randomUUID(), orgId, graphic.id),
  ]);
  expect((await getTmGraphicsState({ data: { orgId } })).program).toEqual([
    { id: graphic.id, title: "Legacy Program" },
  ]);
  await writeTmGraphicsClear({ data: await command() });
  expect(await getActiveGraphics({ data: { orgId } })).toEqual([]);
});
async function command() {
  const { orgId } = authenticated,
    snapshot = await getTmGraphicsState({ data: { orgId } });
  return {
    orgId,
    requestId: crypto.randomUUID(),
    expectedProgramRevision: snapshot.programRevision,
    expectedRelayRevision: snapshot.relayRevision,
    expiresAt: Date.now() + 4900,
  };
}
async function publish(title = "Fixture Program") {
  const { orgId } = authenticated;
  return publishGraphicComposition({
    data: {
      orgId,
      requestId: crypto.randomUUID(),
      items: [
        { key: "fixture", name: title, title, subtitle: "", style: "{}" },
      ],
    },
  });
}
const stub = () =>
  env.LOWER_THIRDS_RELAY.get(
    env.LOWER_THIRDS_RELAY.idFromName(authenticated.orgId),
  );
async function triggerRelay(id: string) {
  const response = await stub().fetch(
    new Request("https://lt/internal/trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET,
      },
      body: JSON.stringify({
        id,
        type: "freetext",
        line1: id,
        style: "default",
      }),
    }),
  );
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}
it("clears current Program and lower-third relay while retaining saved templates", async () => {
  await publish();
  await triggerRelay("First lower third");
  const data = await command();
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "applied",
    relay: "applied",
  });
  expect(
    await getTmGraphicsState({ data: { orgId: authenticated.orgId } }),
  ).toMatchObject({ program: [], lowerThirds: [] });
  expect(
    await getPrisma().graphicTemplate.count({
      where: { orgId: authenticated.orgId },
    }),
  ).toBe(1);
});
it("rejects a stale confirmation and preserves both newer outputs", async () => {
  await publish();
  await triggerRelay("First lower third");
  const data = await command();
  await publish("New Program");
  await triggerRelay("New lower third");
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "conflict",
    relay: "skipped",
  });
  expect(
    await getTmGraphicsState({ data: { orgId: authenticated.orgId } }),
  ).toMatchObject({
    program: [{ title: "New Program" }],
    lowerThirds: ["New lower third"],
  });
});
it("advances the Program revision even when the same pointer is selected again", async () => {
  await publish();
  const data = await command();
  await env.DB.prepare(
    "UPDATE app_setting SET value=value WHERE orgId=? AND key='active-graphics'",
  )
    .bind(authenticated.orgId)
    .run();
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "conflict",
    relay: "skipped",
  });
  expect(
    await getActiveGraphics({ data: { orgId: authenticated.orgId } }),
  ).toHaveLength(1);
});
it("invalidates a reviewed clear when an on-air template is edited", async () => {
  const published = await publish(),
    data = await command();
  await env.DB.prepare(
    "UPDATE graphic_template SET title='New live text' WHERE id=? AND orgId=?",
  )
    .bind(published.publishedIds[0], authenticated.orgId)
    .run();
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "conflict",
  });
});
it("does not invalidate output review for an unrelated template edit", async () => {
  await publish();
  const id = crypto.randomUUID();
  await getPrisma().graphicTemplate.create({
    data: {
      id,
      orgId: authenticated.orgId,
      name: "Unrelated",
      title: "",
      subtitle: "",
      style: "{}",
    },
  });
  const data = await command();
  await getPrisma().graphicTemplate.update({
    where: { id, orgId: authenticated.orgId },
    data: { title: "Still unrelated" },
  });
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "applied",
    relay: "applied",
  });
});
it("preserves a newer relay publication and reports partial completion", async () => {
  await publish();
  await triggerRelay("Reviewed lower third");
  const data = await command();
  await triggerRelay("New relay publication");
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "applied",
    relay: "conflict",
  });
  expect(
    await getTmGraphicsState({ data: { orgId: authenticated.orgId } }),
  ).toMatchObject({ program: [], lowerThirds: ["New relay publication"] });
});
it("does not clear either output after the original deadline", async () => {
  await publish();
  await triggerRelay("Reviewed lower third");
  const data = await command();
  data.expiresAt = Date.now() - 1;
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "expired",
    relay: "skipped",
  });
  expect(
    await getTmGraphicsState({ data: { orgId: authenticated.orgId } }),
  ).toMatchObject({
    program: [{ title: "Fixture Program" }],
    lowerThirds: ["Reviewed lower third"],
  });
});
it("binds receipts to the original command and rechecks current permission on replay", async () => {
  await publish();
  const data = await command();
  await writeTmGraphicsClear({ data });
  await expect(
    writeTmGraphicsClear({ data: { ...data, expectedProgramRevision: 0 } }),
  ).rejects.toThrow(/different graphics clear/);
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(authenticated.orgId, authenticated.userId)
    .run();
  await expect(writeTmGraphicsClear({ data })).rejects.toThrow(/permission/);
});
it("fails closed on expired sessions, another organization, and disabled cloud graphics", async () => {
  const data = await command(),
    other = await seedRelayMember(crypto.randomUUID());
  await expect(
    writeTmGraphicsClear({ data: { ...data, orgId: other.orgId } }),
  ).rejects.toThrow(/permission/);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=0 WHERE id=?")
    .bind(authenticated.orgId)
    .run();
  await expect(writeTmGraphicsClear({ data })).rejects.toThrow(/unavailable/);
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(writeTmGraphicsClear({ data })).rejects.toThrow(/Sign in/);
});
it("recovers a lost relay acknowledgement without clearing a newer publication", async () => {
  await publish();
  await triggerRelay("Original lower third");
  const data = await command();
  let lost = true;
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("UPDATE graphics_clear_receipt SET relayOutcome"))
            return statement;
          return new Proxy(statement, {
            get(original, key) {
              if (key === "bind")
                return (...values: unknown[]) => {
                  const bound = original.bind(...values);
                  return new Proxy(bound, {
                    get(value, member) {
                      if (member === "run")
                        return async () => {
                          if (lost) {
                            lost = false;
                            throw new Error("Fixture lost acknowledgement");
                          }
                          return value.run();
                        };
                      const result = Reflect.get(value, member, value);
                      return typeof result === "function"
                        ? result.bind(value)
                        : result;
                    },
                  });
                };
              const value = Reflect.get(original, key, original);
              return typeof value === "function" ? value.bind(original) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    clearTmGraphics(data, new Headers({ Cookie: auth.cookie }), database),
  ).rejects.toThrow(/lost acknowledgement/);
  await publish("New Program");
  await triggerRelay("New lower third");
  await evictDurableObject(stub());
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "applied",
    relay: "applied",
  });
  expect(
    await getTmGraphicsState({ data: { orgId: authenticated.orgId } }),
  ).toMatchObject({
    program: [{ title: "New Program" }],
    lowerThirds: ["New lower third"],
  });
});
it("keeps duplicate concurrent clear requests to one receipt", async () => {
  await publish();
  await triggerRelay("Original lower third");
  const data = await command();
  const result = await Promise.all([
    writeTmGraphicsClear({ data }),
    writeTmGraphicsClear({ data }),
  ]);
  expect(
    result.every(
      (result) => result.program === "applied" && result.relay === "applied",
    ),
  ).toBe(true);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM graphics_clear_receipt WHERE orgId=?",
  )
    .bind(authenticated.orgId)
    .first<{ count: number }>();
  expect(count?.count).toBe(1);
});

async function grantGraphics() {
  const { orgId, userId } = authenticated;
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  for (const permissions of [
    ["dashboard:tm"],
    ["lowerthird:view", "lowerthird:trigger"],
  ])
    await env.DB.prepare(
      "INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,expiresOn,grantedByUserId) VALUES(?,?,?,'fixture',?,'2000-01-01','2099-01-01',?)",
    )
      .bind(
        crypto.randomUUID(),
        orgId,
        userId,
        JSON.stringify(permissions),
        userId,
      )
      .run();
}
it("supports both temporary permissions and denies a missing graphics grant", async () => {
  await publish();
  await grantGraphics();
  const data = await command();
  expect(await writeTmGraphicsClear({ data })).toMatchObject({
    program: "applied",
    relay: "applied",
  });
  await env.DB.prepare(
    "UPDATE member_permission_grant SET permissions='[]' WHERE orgId=? AND permissions LIKE '%lowerthird%'",
  )
    .bind(authenticated.orgId)
    .run();
  await expect(writeTmGraphicsClear({ data })).rejects.toThrow(/permission/);
});
it.each(["permission", "deleting", "cloud", "revision"])(
  "checks %s again at the atomic Program clear",
  async (kind) => {
    await publish();
    const data = await command();
    const database: Pick<D1Database, "prepare" | "batch"> = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (kind === "permission")
          await env.DB.prepare(
            "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
          )
            .bind(authenticated.orgId, authenticated.userId)
            .run();
        if (kind === "deleting")
          await env.DB.prepare(
            "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
          )
            .bind(crypto.randomUUID(), authenticated.orgId)
            .run();
        if (kind === "cloud")
          await env.DB.prepare(
            "UPDATE organization SET cloud_enabled=0 WHERE id=?",
          )
            .bind(authenticated.orgId)
            .run();
        if (kind === "revision") await publish("Changed at commit");
        return env.DB.batch(statements);
      },
    };
    const operation = clearTmGraphics(
      data,
      new Headers({ Cookie: auth.cookie }),
      database,
    );
    if (kind === "revision")
      expect(await operation).toMatchObject({
        program: "conflict",
        relay: "skipped",
      });
    else await expect(operation).rejects.toThrow(/access changed/);
    expect(
      await env.DB.prepare(
        "SELECT value FROM app_setting WHERE orgId=? AND key='active-graphics'",
      )
        .bind(authenticated.orgId)
        .first(),
    ).not.toBeNull();
  },
);
it("clears malformed saved output only through explicit revision-bound confirmation", async () => {
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-graphics','broken-json')",
  )
    .bind(crypto.randomUUID(), authenticated.orgId)
    .run();
  expect(
    (await getTmGraphicsState({ data: { orgId: authenticated.orgId } }))
      .programUnknown,
  ).toBe(true);
  expect(await writeTmGraphicsClear({ data: await command() })).toMatchObject({
    program: "applied",
    relay: "applied",
  });
  expect(
    (await getTmGraphicsState({ data: { orgId: authenticated.orgId } }))
      .programUnknown,
  ).toBe(false);
});

it("does not expose a clear or save its receipt when relay persistence fails", async () => {
  await triggerRelay("Still live");
  const data = await command();
  await runInDurableObject(stub(), async (instance, ctx) => {
    const saved = await ctx.storage.get("state");
    const url = new URL("https://graphics/clear-reviewed");
    for (const [key, value] of Object.entries({
      orgId: authenticated.orgId,
      authUserId: authenticated.userId,
      authSessionId: authenticated.actor.sessionId,
      access: "write",
    }))
      url.searchParams.set(key, value);
    const spy = vi
      .spyOn(ctx.storage, "put")
      .mockRejectedValueOnce(new Error("Fixture persistence failure"));
    try {
      await expect(
        instance.fetch(
          new Request(url, {
            method: "POST",
            body: JSON.stringify({
              id: "a".repeat(64),
              expectedRevision: data.expectedRelayRevision,
              expiresAt: data.expiresAt,
            }),
          }),
        ),
      ).rejects.toThrow(/persistence failure/);
    } finally {
      spy.mockRestore();
    }
    url.pathname = "/control-state";
    expect(await (await instance.fetch(new Request(url))).json()).toMatchObject(
      {
        revision: data.expectedRelayRevision,
        current: { line1: "Still live" },
      },
    );
    expect(await ctx.storage.get("state")).toEqual(saved);
  });
});
