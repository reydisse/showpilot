import { z } from "zod";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import {
  addCrewMember,
  updateCrewMember,
  deleteCrewMember,
  getCrewMembers,
} from "../data";
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
beforeEach(() => {
  auth.cookie = "";
  vi.restoreAllMocks();
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
  const input = {
    orgId,
    memberId: "CAM42",
    name: "Casey Crew",
    role: "Camera",
    email: "casey@example.test",
    photoUrl: "",
    requestId: crypto.randomUUID(),
  };
  const row = () =>
    getPrisma().crewMember.findFirstOrThrow({
      where: { orgId, memberId: "CAM42" },
    });
  return { orgId, userId, input, row };
}

it("recovers a creation acknowledgement without inserting another crew record", async () => {
  const f = await fixture();
  const first = await addCrewMember({ data: f.input });
  expect(await addCrewMember({ data: f.input })).toMatchObject({
    id: first.id,
  });
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("does not overwrite newer crew details when an old edit reply was lost", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  const edit = {
    orgId: f.orgId,
    id: row.id,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    updates: { role: "Audio" },
  };
  await updateCrewMember({ data: edit });
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { role: "Lighting" },
  });
  await updateCrewMember({ data: edit });
  expect((await f.row()).role).toBe("Lighting");
});

it("recovers removal after its reply was lost without deleting a replacement badge holder", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  const removal = {
    orgId: f.orgId,
    id: row.id,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
  };
  await deleteCrewMember({ data: removal });
  const replacement = await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: "CAM42",
      name: "New badge holder",
      role: "Camera",
    },
  });
  await expect(deleteCrewMember({ data: removal })).resolves.toBeDefined();
  expect((await f.row()).id).toBe(replacement.id);
});

it("rejects an edit based on an older displayed crew profile", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { name: "Updated name" },
  });
  const edit = {
    orgId: f.orgId,
    id: row.id,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    updates: { name: "Old draft" },
  };
  await expect(updateCrewMember({ data: edit })).rejects.toThrow("changed");
  expect((await f.row()).name).toBe("Updated name");
});

it("admits concurrent exact creation once and rejects changed contents for its receipt", async () => {
  const f = await fixture();
  const results = await Promise.all([
    addCrewMember({ data: f.input }),
    addCrewMember({ data: f.input }),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
  await expect(
    addCrewMember({ data: { ...f.input, name: "Different request" } }),
  ).rejects.toThrow("different crew changes");
});

it("can recover a server-generated request ID without recreating a subsequently deleted record", async () => {
  const f = await fixture();
  const { requestId: ignored, ...data } = f.input;
  expect(ignored).toBeTruthy();
  const first = await addCrewMember({ data });
  await getPrisma().crewMember.delete({ where: { id: first.id } });
  expect(
    await addCrewMember({ data: { ...data, requestId: first.requestId } }),
  ).toEqual(first);
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});

it("rolls back receipts if a crew insert fails, and can recover with the same request", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "CREATE TRIGGER fixture_crew_insert_failure BEFORE INSERT ON crew_member BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END",
  ).run();
  try {
    await expect(addCrewMember({ data: f.input })).rejects.toThrow(
      "could not be confirmed",
    );
    expect(
      await env.DB.prepare("SELECT * FROM crew_write_receipt WHERE orgId=?")
        .bind(f.orgId)
        .first(),
    ).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_crew_insert_failure").run();
  }
  await addCrewMember({ data: f.input });
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("keeps badge uniqueness scoped and lets only one competing create claim it", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    addCrewMember({ data: f.input }),
    addCrewMember({
      data: {
        ...f.input,
        requestId: crypto.randomUUID(),
        name: "Competing person",
      },
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status !== "rejected")
    throw new Error("Expected badge conflict");
  expect(rejected.reason.message).toContain("badge ID is already in use");
});

it("increments profile revisions for every profile writer, independently of attendance", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { isOnline: true, lastCheckIn: new Date() },
  });
  expect((await getCrewMembers({ data: { orgId: f.orgId } }))[0]).toMatchObject(
    { profileRevision: 0, isOnline: true },
  );
  await updateCrewMember({
    data: {
      orgId: f.orgId,
      id: row.id,
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
      updates: { name: "New name" },
    },
  });
  expect((await getCrewMembers({ data: { orgId: f.orgId } }))[0]).toMatchObject(
    { name: "New name", profileRevision: 1, isOnline: true },
  );
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { photoUrl: "fixture-new-photo" },
  });
  expect(
    (await getCrewMembers({ data: { orgId: f.orgId } }))[0].profileRevision,
  ).toBe(2);
  await expect(
    deleteCrewMember({
      data: {
        orgId: f.orgId,
        id: row.id,
        expectedRevision: 1,
        requestId: crypto.randomUUID(),
      },
    }),
  ).rejects.toThrow("changed");
});

it("does not mutate a target in another organization or replay after membership revocation", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  await expect(
    updateCrewMember({
      data: {
        orgId: "other-org",
        id: row.id,
        updates: { name: "Wrong org" },
        requestId: crypto.randomUUID(),
      },
    }),
  ).rejects.toThrow("access");
  await getPrisma().member.deleteMany({
    where: { organizationId: f.orgId, userId: f.userId },
  });
  await expect(addCrewMember({ data: f.input })).rejects.toThrow("access");
  expect((await f.row()).name).toBe("Casey Crew");
});

it("checks actor and target at the transaction boundary", async () => {
  const { writeCrewProfile } = await import("../crew-roster.server");
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  const actor = { userId: f.userId, sessionId: session.session.id };
  const targetRace = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().crewMember.update({
        where: { id: row.id },
        data: { name: "Concurrent profile" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    writeCrewProfile(targetRace, actor, {
      kind: "update",
      orgId: f.orgId,
      id: row.id,
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
      updates: { name: "Stale edit" },
    }),
  ).rejects.toThrow("changed");
  expect((await f.row()).name).toBe("Concurrent profile");
  const actorRace = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().member.updateMany({
        where: { organizationId: f.orgId, userId: f.userId },
        data: { role: "member" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    writeCrewProfile(actorRace, actor, {
      ...f.input,
      memberId: "SECOND",
      requestId: crypto.randomUUID(),
      kind: "create",
    }),
  ).rejects.toThrow("changed");
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

it("recovers native create, edit and removal through the same receipts as web", async () => {
  const { handleMobileApi } = await import("../mobile-api.server");
  const f = await fixture();
  const call = async (path: string, body?: unknown) => {
    const response = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/team/crew${path}?orgId=${f.orgId}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      ),
      { DB: env.DB },
    );
    if (!response) throw new Error("Missing mobile route");
    return { status: response.status, body: await response.json() };
  };
  const create = await call("", f.input);
  expect(create.status).toBe(201);
  const row = await f.row();
  expect(create.body).toMatchObject({
    ok: true,
    id: row.id,
    requestId: f.input.requestId,
  });
  expect(await call("", f.input)).toEqual(create);
  expect(await addCrewMember({ data: f.input })).toMatchObject({ id: row.id });
  expect((await call("")).body).toMatchObject({
    members: [{ id: row.id, profileRevision: 0 }],
  });
  const update = {
    ...f.input,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    name: "Native updated",
  };
  expect((await call(`/${row.id}/update`, update)).status).toBe(200);
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { name: "Newer update" },
  });
  expect((await call(`/${row.id}/update`, update)).status).toBe(200);
  expect((await f.row()).name).toBe("Newer update");
  expect(
    (
      await call(`/${row.id}/remove`, {
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const removal = { expectedRevision: 2, requestId: crypto.randomUUID() };
  const deleted = await call(`/${row.id}/remove`, removal);
  expect(deleted.status).toBe(200);
  expect(await call(`/${row.id}/remove`, removal)).toEqual(deleted);
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});

it("rejects foreign targets, expired sessions, and reused native request payloads", async () => {
  const { handleMobileApi } = await import("../mobile-api.server");
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const other = await seedRelayMember(crypto.randomUUID());
  const foreign = await getPrisma().crewMember.create({
    data: {
      orgId: other.orgId,
      memberId: "CAM42",
      name: "Foreign person",
      role: "Camera",
    },
  });
  await expect(
    updateCrewMember({
      data: {
        orgId: f.orgId,
        id: foreign.id,
        expectedRevision: 0,
        updates: { name: "Wrong target" },
      },
    }),
  ).rejects.toThrow("no longer in the roster");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/crew?orgId=${f.orgId}`,
      {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ...f.input, name: "Different payload" }),
      },
    ),
    { DB: env.DB },
  );
  expect(response?.status).toBe(409);
  await getPrisma().session.updateMany({
    where: { userId: f.userId },
    data: { expiresAt: new Date(0) },
  });
  await expect(addCrewMember({ data: f.input })).rejects.toThrow("Sign in");
  expect(
    (
      await getPrisma().crewMember.findUniqueOrThrow({
        where: { id: foreign.id },
      })
    ).name,
  ).toBe("Foreign person");
});

it("rejects a whitespace badge before normalization and accepts the native 128-character badge limit", async () => {
  const f = await fixture();
  await expect(
    addCrewMember({ data: { ...f.input, memberId: "   " } }),
  ).rejects.toThrow("Badge ID");
  const longBadge = "A".repeat(128);
  const created = await addCrewMember({
    data: { ...f.input, memberId: longBadge },
  });
  expect(
    (
      await getPrisma().crewMember.findUniqueOrThrow({
        where: { id: created.id },
      })
    ).memberId,
  ).toBe(longBadge);
});

it("a roster read alone cannot cancel an undelivered crew creation", async () => {
  const f = await fixture();
  expect(await getCrewMembers({ data: { orgId: f.orgId } })).toEqual([]);
  await addCrewMember({ data: f.input });
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});

async function recovery(
  f: Awaited<ReturnType<typeof fixture>>,
  command: unknown,
  review = false,
) {
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/crew/${review ? "review" : "command"}?orgId=${f.orgId}`,
      {
        method: "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing route");
  return response;
}
const creation = (f: Awaited<ReturnType<typeof fixture>>) => ({
  ...f.input,
  userId: f.userId,
  kind: "create",
});
it("review cancels a delayed native creation, including legacy retries of the same request", async () => {
  const f = await fixture(),
    command = creation(f);
  const cancelled = await recovery(f, command, true);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    outcome: "cancelled",
    id: null,
    requestId: command.requestId,
    userId: f.userId,
  });
  expect(await (await recovery(f, command)).json()).toMatchObject({
    outcome: "cancelled",
    id: null,
  });
  await expect(addCrewMember({ data: f.input })).rejects.toThrow("cancelled");
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});
it.each(["update", "delete"] as const)(
  "review fences a delayed native %s without changing the crew profile",
  async (kind) => {
    const f = await fixture();
    await addCrewMember({ data: f.input });
    const row = await f.row();
    const command = {
      ...(kind === "update" ? f.input : {}),
      orgId: f.orgId,
      userId: f.userId,
      requestId: crypto.randomUUID(),
      kind,
      id: row.id,
      expectedRevision: (await getCrewMembers({ data: { orgId: f.orgId } }))[0]
        .profileRevision,
      ...(kind === "update" ? { name: "Late update" } : {}),
    };
    expect(await (await recovery(f, command, true)).json()).toMatchObject({
      outcome: "cancelled",
      id: row.id,
    });
    expect(await (await recovery(f, command)).json()).toMatchObject({
      outcome: "cancelled",
      id: row.id,
    });
    expect((await f.row()).name).toBe(f.input.name);
  },
);
it("review recovers a saved native command without restoring older profile details", async () => {
  const f = await fixture(),
    command = creation(f);
  const applied = await (await recovery(f, command)).json();
  expect(applied).toMatchObject({
    outcome: "applied",
    requestId: command.requestId,
  });
  await getPrisma().crewMember.updateMany({
    where: { orgId: f.orgId },
    data: { name: "Later name" },
  });
  expect(await (await recovery(f, command, true)).json()).toEqual(applied);
  expect((await f.row()).name).toBe("Later name");
});
it("send and review racing agree on one native result", async () => {
  const f = await fixture(),
    command = creation(f);
  const replies = await Promise.all([
    recovery(f, command),
    recovery(f, command, true),
  ]);
  expect(replies.map((r) => r.status)).toEqual([200, 200]);
  const [sent, reviewed] = await Promise.all(replies.map((r) => r.json()));
  expect(sent).toEqual(reviewed);
  const parsed = z
    .object({ outcome: z.enum(["applied", "cancelled"]) })
    .parse(sent);
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(parsed.outcome === "applied" ? 1 : 0);
});
it("rejects a different payload under a cancelled request and permits a fresh reviewed request", async () => {
  const f = await fixture(),
    command = creation(f);
  await recovery(f, command, true);
  expect((await recovery(f, { ...command, name: "Changed" })).status).toBe(409);
  expect(
    (
      await recovery(f, {
        ...command,
        requestId: crypto.randomUUID(),
        name: "Changed",
      })
    ).status,
  ).toBe(200);
  expect((await f.row()).name).toBe("Changed");
});
it("rejects another native actor, malformed photos and cross-org profiles", async () => {
  const f = await fixture(),
    command = creation(f);
  expect(
    (await recovery(f, { ...command, userId: "wrong" }, true)).status,
  ).toBe(403);
  expect(
    (await recovery(f, { ...command, photoUrl: "javascript:alert(1)" })).status,
  ).toBe(400);
  const other = await seedRelayMember(crypto.randomUUID());
  const foreign = await getPrisma().crewMember.create({
    data: {
      orgId: other.orgId,
      memberId: "OTHER",
      name: "Private",
      role: "Audio",
    },
  });
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/crew/profile?${new URLSearchParams({ orgId: f.orgId, userId: f.userId, id: foreign.id })}`,
      { headers: { Cookie: auth.cookie } },
    ),
    { DB: env.DB },
  );
  expect(await response?.json()).toMatchObject({ snapshot: null });
});
it.each(["session", "role", "deleting"])(
  "does not cancel or apply a crew request after %s authority changes",
  async (change) => {
    const f = await fixture();
    const { crewActor, recoverCrewProfile } =
      await import("../crew-roster.server");
    const actor = await crewActor(new Headers({ Cookie: auth.cookie }));
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
    await expect(
      recoverCrewProfile(env.DB, actor, { ...f.input, kind: "create" }, true),
    ).rejects.toThrow();
    await expect(
      recoverCrewProfile(env.DB, actor, { ...f.input, kind: "create" }, false),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT 1 FROM crew_write_receipt WHERE orgId=?")
        .bind(f.orgId)
        .first(),
    ).toBeNull();
  },
);

it.each([
  ["session", "commit"],
  ["role", "commit"],
  ["deleting", "commit"],
  ["session", "reply"],
  ["role", "reply"],
  ["deleting", "reply"],
])(
  "rechecks %s authority at the review %s boundary",
  async (change, boundary) => {
    const f = await fixture();
    const { crewActor, reviewCrewProfile } =
      await import("../crew-roster.server");
    const actor = await crewActor(new Headers({ Cookie: auth.cookie }));
    async function revoke() {
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
    }
    const database = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            const statement = env.DB.prepare(sql).bind(...params);
            return {
              all: <T>() => statement.all<T>(),
              first: async <T>() => {
                if (
                  boundary === "reply" &&
                  sql.startsWith("SELECT fingerprint")
                )
                  await revoke();
                return statement.first<T>();
              },
              run: async () => {
                if (
                  boundary === "commit" &&
                  sql.startsWith("INSERT INTO crew_write_receipt")
                )
                  await revoke();
                return statement.run();
              },
            };
          },
        };
      },
      batch: async () => {
        throw new Error("Review should use one atomic statement");
      },
    };
    await expect(
      reviewCrewProfile(database, actor, { ...f.input, kind: "create" }),
    ).rejects.toThrow("authority changed");
    const receipt = await env.DB.prepare(
      "SELECT outcome FROM crew_write_receipt WHERE orgId=?",
    )
      .bind(f.orgId)
      .first();
    expect(receipt).toEqual(
      boundary === "commit" ? null : { outcome: "cancelled" },
    );
    expect(
      await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
    ).toBe(0);
  },
);

it("reads the native profile revision and reviews an edit rejected for a stale version", async () => {
  const f = await fixture();
  await addCrewMember({ data: f.input });
  const row = await f.row();
  await getPrisma().crewMember.update({
    where: { id: row.id },
    data: { name: "Current name" },
  });
  const { handleMobileApi } = await import("../mobile-api.server");
  const { crewReadSchema, crewReceiptSchema } =
    await import("../../../../mobile/src/lib/crew-recovery");
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/crew/profile?${new URLSearchParams({ orgId: f.orgId, userId: f.userId, id: row.id })}`,
      { headers: { Cookie: auth.cookie } },
    ),
    { DB: env.DB },
  );
  const current = crewReadSchema.parse(await response?.json());
  expect(current.snapshot).toMatchObject({
    name: "Current name",
    profileRevision: 1,
  });
  const command = {
    ...creation(f),
    kind: "update",
    id: row.id,
    expectedRevision: 0,
    requestId: crypto.randomUUID(),
  };
  expect((await recovery(f, command)).status).toBe(409);
  const result = crewReceiptSchema.parse(
    await (await recovery(f, command, true)).json(),
  );
  expect(result).toMatchObject({ outcome: "cancelled", id: row.id });
  expect((await f.row()).name).toBe("Current name");
});
