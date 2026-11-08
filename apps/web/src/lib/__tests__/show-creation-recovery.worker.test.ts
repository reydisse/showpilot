import { env } from "cloudflare:workers";
import { persistRundownItemsForOrg } from "../rundown";
import { readStoredRundownItems } from "../rundown-item-storage.server";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { createNextService } from "../pm-actions";
import { createServiceForOrg } from "../service-creation.server";

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

function command(orgId: string) {
  return {
    orgId,
    requestId: crypto.randomUUID(),
    serviceDate: "2099-02-01",
    name: "Original show",
    location: "Main room",
    startTime: "10:00",
    timeZone: "UTC",
  };
}

it("web creation retries the same request without creating another show", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const first = await createNextService({ data: input });
  const replay = await createNextService({ data: input });
  expect(replay.showId).toBe(first.showId);
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(1);
});

it("an exact creation retry still acknowledges the original show after later edits", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const first = await createServiceForOrg(input, actor.headers);
  await getPrisma().rundown.update({
    where: { id: first.showId },
    data: { name: "Newer operator title" },
  });
  await expect(
    createServiceForOrg(input, actor.headers),
  ).resolves.toMatchObject({ ok: true, showId: first.showId });
  expect(
    await getPrisma().rundown.findUnique({ where: { id: first.showId } }),
  ).toMatchObject({ name: "Newer operator title" });
});

it("a delayed creation retry cannot recreate a deliberately deleted show", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const first = await createServiceForOrg(input, actor.headers);
  await getPrisma().rundown.delete({ where: { id: first.showId } });
  await expect(createServiceForOrg(input, actor.headers)).rejects.toThrow(
    /removed|deleted/i,
  );
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(0);
});

it("rejects a changed payload, account or organization without rewriting the original show", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  await createServiceForOrg(input, actor.headers);
  await expect(
    createServiceForOrg({ ...input, name: "Different" }, actor.headers),
  ).rejects.toThrow(/different/);
  await expect(
    createServiceForOrg({ ...input, copyFrom: "2099-01-01" }, actor.headers),
  ).rejects.toThrow(/different/);
  const other = await fixture();
  await expect(createServiceForOrg(input, other.headers)).rejects.toThrow(
    /permission|session/,
  );
  await expect(
    createServiceForOrg({ ...input, orgId: other.orgId }, other.headers),
  ).rejects.toThrow();
  await expect(createServiceForOrg(input, new Headers())).rejects.toThrow(
    /account/,
  );
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(1);
  expect(
    await getPrisma().rundown.count({ where: { orgId: other.orgId } }),
  ).toBe(0);
});

it("concurrent identical requests create one show and one receipt", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => createServiceForOrg(input, actor.headers)),
  );
  expect(new Set(results.map((result) => result.showId)).size).toBe(1);
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM show_creation_request WHERE orgId=?",
      )
        .bind(actor.orgId)
        .first()
    )?.n,
  ).toBe(1);
});

it("concurrent different requests cannot both take the last free show slot", async () => {
  const actor = await fixture();
  for (let i = 0; i < 2; i++)
    await createServiceForOrg(command(actor.orgId), actor.headers);
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      createServiceForOrg(command(actor.orgId), actor.headers),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(3);
});

it("inventory defaults and clean cloned execution state commit with the show and survive later source changes", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const inventory = await getPrisma().showInventoryItem.create({
    data: {
      orgId: actor.orgId,
      name: "Inventory show",
      location: "Inventory room",
      defaultStartTime: "09:30",
      rundownJson: JSON.stringify([
        {
          id: "live-item",
          title: "Opening",
          type: "song",
          duration: 300000,
          notes: "Original notes",
          assignee: "Choir",
          cue: "Standby",
          status: "active",
          sortOrder: 2,
          hardStop: true,
          scheduledStart: "2099-01-01T10:00:00Z",
          expectedEnd: "2099-01-01T10:05:00Z",
          actualStart: "2099-01-01T10:00:00Z",
          actualEnd: "2099-01-01T10:05:00Z",
        },
      ]),
    },
  });
  await getPrisma().appSetting.create({
    data: { orgId: actor.orgId, key: "org-timezone", value: "America/Toronto" },
  });
  const selected = {
    ...input,
    name: undefined,
    location: undefined,
    startTime: undefined,
    inventoryId: inventory.id,
    callTime: "08:30",
    timeZone: "UTC",
  };
  const created = await createServiceForOrg(selected, actor.headers);
  const show = await getPrisma().rundown.findUniqueOrThrow({
    where: { id: created.showId },
  });
  expect(show).toMatchObject({
    name: "Inventory show",
    location: "Inventory room",
    status: "stopped",
  });
  expect(show.scheduledStartTime?.toISOString()).toBe(
    "2099-02-01T14:30:00.000Z",
  );
  expect(show.scheduledCallTime?.toISOString()).toBe(
    "2099-02-01T08:30:00.000Z",
  );
  const rows = await readStoredRundownItems(env.DB, {
    orgId: actor.orgId,
    serviceDate: input.serviceDate,
    showId: created.showId,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: created.showId + "-0",
    title: "Opening",
    notes: "Original notes",
    status: "upcoming",
    sortOrder: 0,
    hardStop: true,
    scheduledStart: null,
    expectedEnd: null,
    actualStart: null,
    actualEnd: null,
  });
  await getPrisma().showInventoryItem.delete({ where: { id: inventory.id } });
  await getPrisma().appSetting.update({
    where: { orgId_key: { orgId: actor.orgId, key: "org-timezone" } },
    data: { value: "Asia/Tokyo" },
  });
  await expect(
    createServiceForOrg(selected, actor.headers),
  ).resolves.toMatchObject({ showId: created.showId });
  expect(
    await readStoredRundownItems(env.DB, {
      orgId: actor.orgId,
      serviceDate: input.serviceDate,
      showId: created.showId,
    }),
  ).toEqual(rows);
});

it("clones an owned source show once and preserves later target rundown edits on replay", async () => {
  const actor = await fixture();
  const source = await createServiceForOrg(command(actor.orgId), actor.headers);
  await persistRundownItemsForOrg(
    actor.orgId,
    source.serviceDate,
    [
      {
        id: "source-item",
        title: "Original opening",
        status: "done",
        actualEnd: Date.now(),
      },
    ],
    source.showId,
  );
  const input = {
    ...command(actor.orgId),
    serviceDate: "2099-02-08",
    copyFrom: source.serviceDate,
    copyFromShowId: source.showId,
  };
  const created = await createServiceForOrg(input, actor.headers);
  let rows = await readStoredRundownItems(env.DB, {
    orgId: actor.orgId,
    serviceDate: input.serviceDate,
    showId: created.showId,
  });
  expect(rows[0]).toMatchObject({
    title: "Original opening",
    status: "upcoming",
    actualEnd: null,
  });
  await persistRundownItemsForOrg(
    actor.orgId,
    input.serviceDate,
    [{ ...rows[0], title: "Later target edit" }],
    created.showId,
  );
  await getPrisma().rundown.delete({ where: { id: source.showId } });
  await createServiceForOrg(input, actor.headers);
  rows = await readStoredRundownItems(env.DB, {
    orgId: actor.orgId,
    serviceDate: input.serviceDate,
    showId: created.showId,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe("Later target edit");
});

it("a failed seed batch rolls back the receipt, show and storage marker before a safe retry", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const broken = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>([
        ...statements,
        env.DB.prepare(
          "INSERT INTO missing_show_fixture_table(id) VALUES ('fail')",
        ),
      ]),
  };
  await expect(
    createServiceForOrg(input, actor.headers, broken),
  ).rejects.toThrow();
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM show_creation_request WHERE orgId=?",
    )
      .bind(actor.orgId)
      .first(),
  ).toBeNull();
  expect(
    await getPrisma().appSetting.count({
      where: {
        orgId: actor.orgId,
        key: `rundown-items-storage:${input.requestId}`,
      },
    }),
  ).toBe(0);
  await expect(
    createServiceForOrg(input, actor.headers),
  ).resolves.toMatchObject({ showId: input.requestId });
});

it("permission revoked during preparation prevents the entire creation", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const revoked = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await getPrisma().member.updateMany({
        where: { organizationId: actor.orgId, userId: actor.userId },
        data: { role: "member" },
      });
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    createServiceForOrg(input, actor.headers, revoked),
  ).rejects.toThrow(/permission/);
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM show_creation_request WHERE orgId=?",
    )
      .bind(actor.orgId)
      .first(),
  ).toBeNull();
});

it("rejects malformed and foreign inventory without silently creating an empty show", async () => {
  const actor = await fixture(),
    other = await fixture(),
    input = command(actor.orgId);
  const bad = await getPrisma().showInventoryItem.create({
    data: { orgId: actor.orgId, name: "Broken", rundownJson: "not json" },
  });
  const foreign = await getPrisma().showInventoryItem.create({
    data: { orgId: other.orgId, name: "Private", rundownJson: "[]" },
  });
  await expect(
    createServiceForOrg({ ...input, inventoryId: bad.id }, actor.headers),
  ).rejects.toThrow(/could not be read/);
  await expect(
    createServiceForOrg({ ...input, inventoryId: foreign.id }, actor.headers),
  ).rejects.toThrow(/not found/);
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(0);
});

it("replays the original request even after all free show slots are occupied", async () => {
  const actor = await fixture(),
    input = command(actor.orgId);
  const first = await createServiceForOrg(input, actor.headers);
  await createServiceForOrg(command(actor.orgId), actor.headers);
  await createServiceForOrg(command(actor.orgId), actor.headers);
  await expect(createServiceForOrg(input, actor.headers)).resolves.toEqual(
    first,
  );
  expect(
    await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
  ).toBe(3);
});

it.each([
  { plan: "pro", status: "active", trial: null, allowed: true },
  { plan: "starter", status: "past_due", trial: null, allowed: true },
  { plan: "pro", status: "canceled", trial: null, allowed: false },
  { plan: "free", status: null, trial: "2099-01-01T00:00:00Z", allowed: true },
  { plan: "free", status: null, trial: Date.UTC(2099, 0, 1), allowed: true },
  { plan: "free", status: null, trial: Date.UTC(2000, 0, 1), allowed: false },
])(
  "checks current show capacity for $plan / $status / $trial inside the transaction",
  async ({ plan, status, trial, allowed }) => {
    const actor = await fixture();
    await env.DB.prepare(
      "UPDATE organization SET plan=?,subscriptionStatus=?,trialEndsAt=? WHERE id=?",
    )
      .bind(plan, status, trial, actor.orgId)
      .run();
    for (let i = 0; i < 3; i++)
      await createServiceForOrg(command(actor.orgId), actor.headers);
    const fourth = createServiceForOrg(command(actor.orgId), actor.headers);
    if (allowed) await expect(fourth).resolves.toMatchObject({ ok: true });
    else await expect(fourth).rejects.toThrow(/allows up to/);
    expect(
      await getPrisma().rundown.count({ where: { orgId: actor.orgId } }),
    ).toBe(allowed ? 4 : 3);
  },
);
