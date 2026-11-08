import { env } from "cloudflare:workers";
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
import { saveServiceDetails, reviewServiceDetails } from "../schedule";
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

it("the web save recovers a lost successful reply without changing the saved version or live revision", async () => {
  const f = await fixture();
  const first = await saveServiceDetails({ data: f.command });
  expect(first.outcome).toBe("applied");
  const before = await f.row(),
    revision = (await f.state()).revision;
  const replay = await saveServiceDetails({ data: f.command });
  expect(replay).toEqual(first);
  expect(await f.row()).toEqual(before);
  expect((await f.state()).revision).toBe(revision);
  expect(await f.receiptCount()).toBe(1);
});

it("replays acknowledge a superseded save without overwriting the newer details", async () => {
  const f = await fixture(),
    first = await f.save();
  const second = await f.save({
    ...f.command,
    requestId: crypto.randomUUID(),
    expectedUpdatedAt: first.snapshot!.updatedAt,
    name: "Newer title",
  });
  const replay = await f.save();
  expect(replay).toMatchObject({
    outcome: "superseded",
    snapshot: second.snapshot,
  });
  expect((await f.state()).serviceName).toBe("Newer title");
  expect(await f.receiptCount()).toBe(2);
});

it("a deleted show stays deleted when its original details save is retried", async () => {
  const f = await fixture();
  await f.save();
  await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?")
    .bind(f.orgId, f.showId)
    .run();
  expect(await f.save()).toMatchObject({ outcome: "removed", snapshot: null });
  expect(await f.row()).toBeNull();
  expect(await f.receiptCount()).toBe(1);
});

it("review fences an undelivered save before editing and permits a new reviewed request", async () => {
  const f = await fixture();
  const reviewed = await reviewServiceDetails({ data: f.command });
  expect(reviewed.outcome).toBe("cancelled");
  expect(await f.save()).toEqual(reviewed);
  expect(await f.row()).toMatchObject({ name: "Original" });
  expect(
    await f.save({
      ...f.command,
      requestId: crypto.randomUUID(),
      name: "Reviewed replacement",
    }),
  ).toMatchObject({
    outcome: "applied",
    snapshot: { name: "Reviewed replacement" },
  });
});

it("two simultaneous exact saves commit once", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.save(), f.save()]);
  expect(first).toEqual(second);
  expect(first.outcome).toBe("applied");
  expect(await f.receiptCount()).toBe(1);
  expect((await f.state()).revision).toBe(1);
});

it("rejects reuse of a request for changed fields or a different authenticated account", async () => {
  const f = await fixture();
  await f.save();
  await expect(
    f.save({ ...f.command, location: "Changed payload" }),
  ).rejects.toThrow(/different details/);
  const other = await actorFixture();
  await seedRelayMember(f.orgId, other.userId);
  await expect(
    saveShowDetailsRequest(
      other.headers,
      { ...f.command, userId: other.userId },
      env,
    ),
  ).rejects.toThrow(/different details/);
  await expect(
    saveShowDetailsRequest(other.headers, f.command, env),
  ).rejects.toThrow(/account changed/);
  expect(await f.row()).toMatchObject({
    name: f.command.name,
    location: f.command.location,
  });
});

it("records stale form conflicts and never lets their retries become new writes", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE rundown SET name='Another operator',updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  const conflict = await f.save();
  expect(conflict).toMatchObject({
    outcome: "conflict",
    snapshot: { name: "Another operator" },
  });
  const fresh = await f.save({
    ...f.command,
    requestId: crypto.randomUUID(),
    expectedUpdatedAt: conflict.snapshot!.updatedAt,
  });
  expect(fresh.outcome).toBe("applied");
  expect((await f.save()).outcome).toBe("conflict");
  expect(await f.row()).toMatchObject({ name: f.command.name });
});

it("checks the database version when a queued save commits", async () => {
  const f = await fixture();
  await f.control("hold");
  const saving = f.save();
  try {
    await expect.poll(() => f.control("waiting")).toBe(true);
    await env.DB.prepare(
      "UPDATE rundown SET name='Concurrent edit',updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.showId)
      .run();
  } finally {
    await f.control("release");
  }
  expect(await saving).toMatchObject({
    outcome: "conflict",
    snapshot: { name: "Concurrent edit" },
  });
});

it("rechecks membership in the commit and rejects replay after revocation", async () => {
  const f = await fixture();
  await f.control("hold");
  const saving = f.save().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await expect.poll(() => f.control("waiting")).toBe(true);
    await env.DB.prepare(
      "DELETE FROM member WHERE organizationId=? AND userId=?",
    )
      .bind(f.orgId, f.userId)
      .run();
  } finally {
    await f.control("release");
  }
  expect(await saving).toEqual({ error: expect.any(Error) });
  expect(await f.receiptCount()).toBe(0);
  expect(await f.row()).toMatchObject({ name: "Original" });
  await expect(f.save()).rejects.toThrow(/permission/);
});

it("rolls back a failed D1 batch and can retry the original request", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "CREATE TRIGGER fail_show_details BEFORE UPDATE OF name ON rundown BEGIN SELECT RAISE(ABORT,'Injected details failure'); END",
  ).run();
  try {
    await expect(f.save()).rejects.toThrow();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_show_details").run();
  }
  expect(await f.receiptCount()).toBe(0);
  expect(await f.row()).toMatchObject({ name: "Original" });
  expect((await f.save()).outcome).toBe("applied");
});

it("repairs a committed save after relay-state persistence fails, using current rows after restart", async () => {
  const f = await fixture();
  await runInDurableObject(f.relay, async (_instance, state) => {
    vi.spyOn(state.storage, "transaction").mockRejectedValueOnce(
      new Error("Injected DO persistence failure"),
    );
  });
  await expect(f.save()).rejects.toThrow(/Could not confirm/);
  expect(await f.row()).toMatchObject({ name: f.command.name });
  expect(await f.receiptCount()).toBe(1);
  await env.DB.prepare(
    "UPDATE rundown SET name='Later database title' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.showId)
    .run();
  await evictDurableObject(f.relay);
  expect((await f.state()).serviceName).toBe("Later database title");
  expect((await f.save()).outcome).toBe("superseded");
  await runInDurableObject(f.relay, async (_instance, state) => {
    expect(await state.storage.get("pending-show-details")).toBeUndefined();
  });
});

it("an in-flight save finishes before its queued review and is never cancelled after acceptance", async () => {
  const f = await fixture();
  await f.control("hold");
  const saving = f.save();
  let reviewing: ReturnType<typeof f.review>;
  try {
    await expect.poll(() => f.control("waiting")).toBe(true);
    reviewing = f.review();
  } finally {
    await f.control("release");
  }
  expect((await saving).outcome).toBe("applied");
  expect((await reviewing!).outcome).toBe("applied");
  expect(await f.receiptCount()).toBe(1);
});

it("retry and cancellation do not depend on newly changed venue timezone settings", async () => {
  const f = await fixture();
  const command = { ...f.command, timeZone: undefined };
  await f.save(command);
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?, 'org-timezone','invalid/timezone')",
  )
    .bind(crypto.randomUUID(), f.orgId)
    .run();
  expect((await f.save(command)).outcome).toBe("applied");
  expect(
    (await f.review({ ...command, requestId: crypto.randomUUID() })).outcome,
  ).toBe("cancelled");
});

it("requires the internal signature, and rejects an invalid retained command before recording it", async () => {
  const f = await fixture();
  const denied = await f.relay.fetch(
    `https://rundown.test/internal/show-details?orgId=${f.orgId}`,
    {
      method: "POST",
      body: JSON.stringify({ command: f.command, mode: "save" }),
    },
  );
  expect(denied.status).toBe(401);
  await denied.body?.cancel();
  await expect(
    f.save({ ...f.command, timeZone: "not/a/timezone" }),
  ).rejects.toThrow(/timezone/);
  expect(await f.receiptCount()).toBe(0);
});

it("a failure clearing the recovery intent does not advance the revision again after restart", async () => {
  const f = await fixture();
  await runInDurableObject(f.relay, async (_instance, state) => {
    vi.spyOn(state.storage, "delete").mockRejectedValueOnce(
      new Error("Injected intent cleanup failure"),
    );
  });
  await expect(f.save()).rejects.toThrow(/Could not confirm/);
  await evictDurableObject(f.relay);
  expect((await f.save()).outcome).toBe("applied");
  expect((await f.state()).revision).toBe(1);
});

it.each(["delete", "reschedule", "retire"] as const)(
  "a pending save cannot ignore a concurrent %s",
  async (change) => {
    const f = await fixture();
    await f.control("hold");
    const saving = f.save();
    try {
      await expect.poll(() => f.control("waiting")).toBe(true);
      if (change === "delete")
        await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?")
          .bind(f.orgId, f.showId)
          .run();
      if (change === "reschedule")
        await env.DB.prepare(
          "UPDATE rundown SET serviceDate='2026-11-09' WHERE orgId=? AND id=?",
        )
          .bind(f.orgId, f.showId)
          .run();
      if (change === "retire")
        await env.DB.prepare(
          "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'deleting')",
        )
          .bind(crypto.randomUUID(), f.orgId, `show-deleting:${f.showId}`)
          .run();
    } finally {
      await f.control("release");
    }
    expect((await saving).outcome).toBe(
      change === "delete" ? "removed" : "conflict",
    );
    expect(await f.row()).toEqual(
      change === "delete"
        ? null
        : expect.objectContaining({ name: "Original" }),
    );
  },
);
