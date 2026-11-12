import { env } from "cloudflare:workers";
import { rundownInternalRequest } from "../rundown-internal-request.server";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember, withRelayMember } from "@/test/relay-fixtures";
import { TestRundownRelay } from "@/test/worker-entry";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { saveShowDetailsRequest } from "../show-details.server";
import type { ShowDetailsCommand } from "../show-details-contract";

afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
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
    serviceDate = "2026-11-08",
    expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name,location,updatedAt) VALUES (?,?,?,'Original','Original room',?)",
  )
    .bind(showId, actor.orgId, serviceDate, expectedUpdatedAt)
    .run();
  const command: ShowDetailsCommand = {
    orgId: actor.orgId,
    userId: actor.userId,
    showId,
    serviceDate,
    expectedUpdatedAt,
    requestId: crypto.randomUUID(),
    name: "Reviewed show",
    startTime: "10:00",
    callTime: "09:00",
    location: "Main room",
    timeZone: "UTC",
  };
  const relay = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`);
  return {
    ...actor,
    showId,
    serviceDate,
    command,
    relay,
    save: (input = command) =>
      saveShowDetailsRequest(actor.headers, input, env),
    review: (input = command) =>
      saveShowDetailsRequest(actor.headers, input, env, "review"),
    row: () =>
      env.DB.prepare(
        "SELECT name,location,updatedAt FROM rundown WHERE orgId=? AND id=?",
      )
        .bind(actor.orgId, showId)
        .first(),
    receiptCount: async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM show_details_request WHERE orgId=?",
        )
          .bind(actor.orgId)
          .first<{ count: number }>()
      )?.count,
    state: async () => {
      const url = await withRelayMember(
        `https://rundown.test/state?orgId=${actor.orgId}&showId=${showId}&serviceDate=${serviceDate}&access=edit`,
      );
      return (await relay.fetch(url)).json<{
        serviceName: string;
        revision: number;
      }>();
    },
    control: (action: "hold" | "release" | "waiting") =>
      runInDurableObject(relay, async (instance) => {
        if (!(instance instanceof TestRundownRelay))
          throw new Error("Missing batch control");
        if (action === "hold") instance.holdNextBatch();
        if (action === "release") instance.releaseBatch();
        return instance.isBatchWaiting();
      }),
  };
}

async function nativeFixture() {
  const f = await fixture();
  const { handleMobileApi } = await import("../mobile-api.server");
  const { rundownDetailsReadSchema, rundownDetailsReplySchema } =
    await import("../../../../mobile/src/lib/rundown-details-recovery");
  const call = async (
    mode: "read" | "save" | "review",
    command: unknown = {},
    pin?: string,
  ) => {
    const url = `https://app.showpilot.tech/api/mobile/v1/rundowns/${f.showId}/details${mode === "read" ? "" : mode === "save" ? "/command" : "/review"}?orgId=${f.orgId}&userId=${f.userId}`;
    const response = await handleMobileApi(
      new Request(url, {
        method: mode === "read" ? "GET" : "POST",
        headers: {
          Cookie: auth.cookie,
          "Content-Type": "application/json",
          ...(pin ? { "x-showpilot-rundown-pin": pin } : {}),
        },
        ...(mode === "read" ? {} : { body: JSON.stringify(command) }),
      }),
      env,
    );
    if (!response) throw new Error("Missing native rundown route");
    return response;
  };
  const read = async (pin?: string) => {
    const result = await call("read", {}, pin);
    expect(result.status).toBe(200);
    return rundownDetailsReadSchema.parse(await result.json());
  };
  const initial = await read();
  const command = {
    ...f.command,
    timeZone: initial.timeZone,
    expectedRevision: initial.revision,
  };
  const save = async (input = command, review = false, pin?: string) => {
    const result = await call(review ? "review" : "save", input, pin);
    expect(result.status).toBe(200);
    return rundownDetailsReplySchema.parse(await result.json());
  };
  return { ...f, call, read, command, save };
}
it("native rundown details retry acknowledges the old save without rewriting newer details", async () => {
  const f = await nativeFixture();
  const result = await f.save();
  expect(result.outcome).toBe("applied");
  const before = await f.row(),
    live = await f.read();
  expect(await f.save()).toEqual(result);
  expect(await f.row()).toEqual(before);
  expect((await f.read()).revision).toBe(live.revision);
  await f.save({
    ...f.command,
    requestId: crypto.randomUUID(),
    expectedRevision: live.revision,
    expectedUpdatedAt: live.snapshot!.updatedAt,
    name: "Later name",
  });
  expect((await f.save()).outcome).toBe("superseded");
  expect(await f.row()).toMatchObject({ name: "Later name" });
});
it("Review cancels an undelivered native metadata request before it arrives", async () => {
  const f = await nativeFixture();
  expect((await f.save(f.command, true)).outcome).toBe("cancelled");
  expect((await f.save()).outcome).toBe("cancelled");
  expect(await f.row()).toMatchObject({ name: "Original" });
  expect(
    (await f.save({ ...f.command, requestId: crypto.randomUUID() })).outcome,
  ).toBe("applied");
});
it("a changed relay revision creates a durable conflict without writing metadata", async () => {
  const f = await nativeFixture();
  await f.relay.fetch(
    rundownInternalRequest(
      `https://rundown.test/command?orgId=${f.orgId}&showId=${f.showId}&serviceDate=${f.serviceDate}&access=edit`,
      env.BETTER_AUTH_SECRET,
      {
        method: "POST",
        body: JSON.stringify({
          action: "stage-message",
          payload: { message: "Another operation" },
        }),
      },
    ),
  );
  expect((await f.save()).outcome).toBe("conflict");
  expect(await f.row()).toMatchObject({ name: "Original" });
  expect((await f.save(f.command, true)).outcome).toBe("conflict");
  const current = await f.read();
  expect(
    (
      await f.save({
        ...f.command,
        requestId: crypto.randomUUID(),
        expectedRevision: current.revision,
        expectedUpdatedAt: current.snapshot!.updatedAt,
      })
    ).outcome,
  ).toBe("applied");
});
it("the same request ID cannot acknowledge different details or another permission family", async () => {
  const f = await nativeFixture();
  await f.save();
  expect(
    (await f.call("save", { ...f.command, name: "Different" })).status,
  ).toBe(503);
  await expect(
    saveShowDetailsRequest(f.headers, f.command, env),
  ).rejects.toThrow("different details");
  expect(await f.row()).toMatchObject({ name: "Reviewed show" });
});
it("native details require matching actor and org identity", async () => {
  const f = await nativeFixture();
  expect((await f.call("save", { ...f.command, userId: "other" })).status).toBe(
    403,
  );
  expect((await f.call("save", { ...f.command, orgId: "other" })).status).toBe(
    403,
  );
  expect((await f.call("save", { ...f.command, showId: "other" })).status).toBe(
    403,
  );
  expect(await f.receiptCount()).toBe(0);
});
const storedPin =
  "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";
async function pinProtected(f: Awaited<ReturnType<typeof nativeFixture>>) {
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.orgId, f.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
  )
    .bind(crypto.randomUUID(), f.orgId, storedPin)
    .run();
}
it("a technical manager uses the current PIN without gaining schedule management", async () => {
  const f = await nativeFixture();
  await pinProtected(f);
  expect((await f.call("read")).status).toBe(401);
  expect((await f.call("save", f.command, "wrong")).status).toBe(401);
  await f.read("2468");
  expect((await f.save(f.command, false, "2468")).outcome).toBe("applied");
  await expect(
    saveShowDetailsRequest(
      f.headers,
      { ...f.command, requestId: crypto.randomUUID() },
      env,
    ),
  ).rejects.toThrow("permission");
}, 30000);
it.each(["session", "role", "pin", "deleting"])(
  "native details check %s changes at commit",
  async (change) => {
    const f = await nativeFixture();
    await pinProtected(f);
    const session = await getAuth().api.getSession({
      headers: f.headers,
      query: { disableCookieCache: true },
    });
    if (!session) throw new Error("Missing session");
    const { writeRundownDetails } =
      await import("../show-details-write.server");
    const revoke = async () => {
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
      if (change === "pin")
        await env.DB.prepare(
          "UPDATE app_setting SET value='rotated' WHERE orgId=? AND key='rundown-pin'",
        )
          .bind(f.orgId)
          .run();
      if (change === "deleting")
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
        )
          .bind(crypto.randomUUID(), f.orgId)
          .run();
    };
    await expect(
      writeRundownDetails(
        env.DB,
        f.command,
        { sessionId: session.session.id, pin: "2468" },
        "save",
        f.command.expectedRevision,
        revoke,
      ),
    ).rejects.toThrow("permission");
    expect(await f.receiptCount()).toBe(0);
    expect(await f.row()).toMatchObject({ name: "Original" });
  },
  // Each case verifies a full-strength 210,000-iteration PIN. CI measured
  // 4.8-5.2s with coverage, so use the existing PIN authority test budget.
  30000,
);
it("metadata persistence and live state recover after relay eviction", async () => {
  const f = await nativeFixture();
  const saved = await f.save();
  await evictDurableObject(f.relay);
  expect(await f.save()).toEqual(saved);
  expect((await f.read()).snapshot?.name).toBe("Reviewed show");
});

async function grantEdit(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  role = "member",
) {
  await env.DB.prepare(
    "UPDATE member SET role=? WHERE organizationId=? AND userId=?",
  )
    .bind(role, f.orgId, f.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,grantedByUserId) VALUES(?,?,?,'rundown','[\"rundown:edit\"]','2000-01-01',?)",
  )
    .bind(crypto.randomUUID(), f.orgId, f.userId, f.userId)
    .run();
}
it("operational grants permit rundown details and revocation at commit prevents the write", async () => {
  const f = await nativeFixture();
  await grantEdit(f);
  expect((await f.save()).outcome).toBe("applied");
  const current = await f.read();
  const command = {
    ...f.command,
    requestId: crypto.randomUUID(),
    expectedRevision: current.revision,
    expectedUpdatedAt: current.snapshot!.updatedAt,
    name: "Revoked write",
  };
  const session = await getAuth().api.getSession({
    headers: f.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Missing session");
  const { writeRundownDetails } = await import("../show-details-write.server");
  await expect(
    writeRundownDetails(
      env.DB,
      command,
      { sessionId: session.session.id, pin: null },
      "save",
      current.revision,
      async () => {
        await env.DB.prepare(
          "UPDATE member_permission_grant SET revokedAt=CURRENT_TIMESTAMP WHERE orgId=?",
        )
          .bind(f.orgId)
          .run();
      },
    ),
  ).rejects.toThrow("permission");
  expect(await f.row()).toMatchObject({ name: "Reviewed show" });
  expect(await f.receiptCount()).toBe(1);
});
it("configuring a PIN after a technical manager's grant was checked prevents the write", async () => {
  const f = await nativeFixture();
  await grantEdit(f, "tm");
  const session = await getAuth().api.getSession({
    headers: f.headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Missing session");
  const { writeRundownDetails } = await import("../show-details-write.server");
  await expect(
    writeRundownDetails(
      env.DB,
      f.command,
      { sessionId: session.session.id, pin: null },
      "save",
      f.command.expectedRevision,
      async () => {
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
        )
          .bind(crypto.randomUUID(), f.orgId, storedPin)
          .run();
      },
    ),
  ).rejects.toThrow("permission");
  expect(await f.row()).toMatchObject({ name: "Original" });
  expect(await f.receiptCount()).toBe(0);
});
it("concurrent save and review agree on the original result", async () => {
  const f = await nativeFixture();
  const results = await Promise.all([f.save(), f.save(f.command, true)]);
  expect(results[0]).toEqual(results[1]);
  expect(await f.receiptCount()).toBe(1);
});
