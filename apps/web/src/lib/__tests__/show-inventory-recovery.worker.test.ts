import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { writeShowInventory } from "../show-inventory-write.server";
import type { InventoryCommand } from "../show-inventory-contract";
import { handleMobileApi } from "../mobile-api.server";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { mutateShowInventory } from "../show-inventory";
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
  const f = await actorFixture();
  const create = {
    orgId: f.orgId,
    userId: f.userId,
    requestId: crypto.randomUUID(),
    name: "Weekly show",
    description: "Reusable",
    location: "Main room",
    defaultStartTime: "10:00",
    sourceTemplateId: "",
  };
  const row = async (id: string) =>
    getPrisma().showInventoryItem.findFirst({ where: { orgId: f.orgId, id } });
  return { ...f, create, row };
}
it("confirms a lost create reply without creating another reusable show", async () => {
  const f = await fixture(),
    data = command(f);
  const first = await mutateShowInventory({ data }),
    retry = await mutateShowInventory({ data });
  expect(retry).toMatchObject({ id: first.id, outcome: "applied" });
  expect(
    await getPrisma().showInventoryItem.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
});
it("confirms an already completed archive when its reply was lost", async () => {
  const f = await fixture();
  await mutateShowInventory({ data: command(f) });
  const data = await archiveCommand(f, true);
  await mutateShowInventory({ data });
  await expect(mutateShowInventory({ data })).resolves.toMatchObject({
    outcome: "applied",
  });
});
it("a late archive retry preserves a later restore", async () => {
  const f = await fixture();
  await mutateShowInventory({ data: command(f) });
  const archive = await archiveCommand(f, true);
  await mutateShowInventory({ data: archive });
  await mutateShowInventory({ data: await archiveCommand(f, false) });
  await expect(mutateShowInventory({ data: archive })).resolves.toMatchObject({
    outcome: "superseded",
  });
  expect((await f.row(f.create.requestId))?.archivedAt).toBeNull();
});
it("rejects a first archive based on a version that another operator changed", async () => {
  const f = await fixture();
  await mutateShowInventory({ data: command(f) });
  const data = await archiveCommand(f, true);
  await env.DB.prepare(
    "UPDATE show_inventory_item SET name='New title',updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
  )
    .bind(f.orgId, f.create.requestId)
    .run();
  await expect(mutateShowInventory({ data })).resolves.toMatchObject({
    outcome: "conflict",
  });
  expect((await f.row(f.create.requestId))?.archivedAt).toBeNull();
});

function command(f: Awaited<ReturnType<typeof fixture>>): InventoryCommand {
  return {
    orgId: f.orgId,
    userId: f.userId,
    requestId: f.create.requestId,
    operation: {
      kind: "create",
      name: f.create.name,
      description: f.create.description,
      location: f.create.location,
      defaultStartTime: f.create.defaultStartTime,
      sourceTemplateId: null,
    },
  };
}
const apply = (
  f: Awaited<ReturnType<typeof fixture>>,
  data: InventoryCommand,
  mode: "apply" | "review" = "apply",
) => writeShowInventory(data, f.headers, mode);
function beforeBatch(
  action: () => Promise<unknown>,
): Pick<D1Database, "prepare" | "batch"> {
  return {
    prepare: (sql) => env.DB.prepare(sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      await action();
      return env.DB.batch<T>(statements);
    },
  };
}
async function archiveCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  archived: boolean,
): Promise<InventoryCommand> {
  const row = await f.row(f.create.requestId);
  if (!row) throw new Error("Missing inventory fixture");
  return {
    orgId: f.orgId,
    userId: f.userId,
    requestId: crypto.randomUUID(),
    operation: {
      kind: "archive",
      id: row.id,
      archived,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    },
  };
}

it("concurrent create retries commit one row and one receipt", async () => {
  const f = await fixture(),
    data = command(f);
  const results = await Promise.all([apply(f, data), apply(f, data)]);
  expect(results.map((r) => r.result.outcome)).toEqual(["applied", "applied"]);
  expect(results.filter((r) => r.appliedNow)).toHaveLength(1);
  expect(
    await getPrisma().showInventoryItem.count({ where: { orgId: f.orgId } }),
  ).toBe(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT requestId FROM show_inventory_request WHERE orgId=?",
      )
        .bind(f.orgId)
        .all()
    ).results,
  ).toHaveLength(1);
});
it("copies a clean source once and confirms the receipt after its template is removed", async () => {
  const f = await fixture(),
    data = command(f),
    sourceId = crypto.randomUUID();
  if (data.operation.kind !== "create") throw new Error("fixture");
  data.operation.sourceTemplateId = sourceId;
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      f.orgId,
      `rundown-saved:${sourceId}`,
      JSON.stringify({
        items: [
          {
            id: "original",
            title: "Welcome",
            status: "complete",
            duration: 60000,
            actualStart: "2026-01-01T00:00:00Z",
            actualEnd: "2026-01-01T00:01:00Z",
          },
        ],
      }),
    )
    .run();
  await apply(f, data);
  const stored = (await f.row(data.requestId))!.rundownJson;
  expect(JSON.parse(stored)).toEqual([
    expect.objectContaining({
      id: `${data.requestId}-item-0`,
      title: "Welcome",
      status: "upcoming",
      actualStart: null,
      actualEnd: null,
      scheduledStart: null,
      expectedEnd: null,
    }),
  ]);
  await env.DB.prepare("DELETE FROM app_setting WHERE orgId=? AND key=?")
    .bind(f.orgId, `rundown-saved:${sourceId}`)
    .run();
  expect((await apply(f, data)).result.outcome).toBe("applied");
  expect((await f.row(data.requestId))!.rundownJson).toBe(stored);
});
it.each([
  "invalid json",
  JSON.stringify({ items: [{ id: "bad" }] }),
  JSON.stringify({ name: "No items" }),
])(
  "rejects a damaged source without silently saving an empty show: %s",
  async (value) => {
    const f = await fixture(),
      data = command(f),
      sourceId = crypto.randomUUID();
    if (data.operation.kind !== "create") throw new Error("fixture");
    data.operation.sourceTemplateId = sourceId;
    await env.DB.prepare(
      "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)",
    )
      .bind(crypto.randomUUID(), f.orgId, `rundown-saved:${sourceId}`, value)
      .run();
    await expect(apply(f, data)).rejects.toThrow(/source|saved rundown/);
    expect(await f.row(data.requestId)).toBeNull();
    expect((await apply(f, data, "review")).result.outcome).toBe("cancelled");
    expect((await apply(f, data)).result.outcome).toBe("cancelled");
    expect(await f.row(data.requestId)).toBeNull();
  },
);
it("does not copy a template changed between source read and commit", async () => {
  const f = await fixture(),
    data = command(f),
    sourceId = crypto.randomUUID();
  if (data.operation.kind !== "create") throw new Error("fixture");
  data.operation.sourceTemplateId = sourceId;
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,'[]')",
  )
    .bind(crypto.randomUUID(), f.orgId, `rundown-saved:${sourceId}`)
    .run();
  const db = beforeBatch(() =>
    env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key=?")
      .bind(
        JSON.stringify([{ id: "new", title: "New source" }]),
        f.orgId,
        `rundown-saved:${sourceId}`,
      )
      .run(),
  );
  expect(
    (await writeShowInventory(data, f.headers, "apply", db)).result.outcome,
  ).toBe("conflict");
  expect(await f.row(data.requestId)).toBeNull();
});
it("checks membership again inside the committing transaction", async () => {
  const f = await fixture(),
    data = command(f);
  const db = beforeBatch(() =>
    env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
      .bind(f.orgId, f.userId)
      .run(),
  );
  await expect(
    writeShowInventory(data, f.headers, "apply", db),
  ).rejects.toThrow("not accepted");
  expect(await f.row(data.requestId)).toBeNull();
  expect(
    (
      await env.DB.prepare(
        "SELECT requestId FROM show_inventory_request WHERE orgId=?",
      )
        .bind(f.orgId)
        .all()
    ).results,
  ).toHaveLength(0);
});
it("rolls back creation and receipt together when D1 rejects the item", async () => {
  const f = await fixture(),
    data = command(f);
  await env.DB.prepare(
    "CREATE TRIGGER inventory_fixture_insert BEFORE INSERT ON show_inventory_item BEGIN SELECT RAISE(ABORT,'fixture insert failed'); END",
  ).run();
  try {
    await expect(apply(f, data)).rejects.toThrow("fixture insert failed");
  } finally {
    await env.DB.prepare("DROP TRIGGER inventory_fixture_insert").run();
  }
  expect(
    (
      await env.DB.prepare(
        "SELECT requestId FROM show_inventory_request WHERE orgId=?",
      )
        .bind(f.orgId)
        .all()
    ).results,
  ).toHaveLength(0);
  expect((await apply(f, data)).result.outcome).toBe("applied");
});
it("rolls back archive and receipt together and allows the identical retry", async () => {
  const f = await fixture();
  await apply(f, command(f));
  const data = await archiveCommand(f, true);
  await env.DB.prepare(
    "CREATE TRIGGER inventory_fixture_update BEFORE UPDATE ON show_inventory_item BEGIN SELECT RAISE(ABORT,'fixture update failed'); END",
  ).run();
  try {
    await expect(apply(f, data)).rejects.toThrow("fixture update failed");
  } finally {
    await env.DB.prepare("DROP TRIGGER inventory_fixture_update").run();
  }
  expect((await f.row(f.create.requestId))?.archivedAt).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM show_inventory_request WHERE orgId=? AND requestId=?",
    )
      .bind(f.orgId, data.requestId)
      .first(),
  ).toBeNull();
  expect((await apply(f, data)).result.outcome).toBe("applied");
});
it("preserves a competing archive/restore update at the actual transaction boundary", async () => {
  const f = await fixture();
  await apply(f, command(f));
  const data = await archiveCommand(f, true);
  const db = beforeBatch(() =>
    env.DB.prepare(
      "UPDATE show_inventory_item SET name='Other operator',updatedAt='2099-01-01T00:00:00.000Z' WHERE orgId=? AND id=?",
    )
      .bind(f.orgId, f.create.requestId)
      .run(),
  );
  expect(
    (await writeShowInventory(data, f.headers, "apply", db)).result.outcome,
  ).toBe("conflict");
  expect((await f.row(f.create.requestId))?.archivedAt).toBeNull();
});
it("replays restore and archive outcomes without undoing later changes and advances legacy numeric versions", async () => {
  const f = await fixture();
  await apply(f, command(f));
  await env.DB.prepare(
    "UPDATE show_inventory_item SET updatedAt=? WHERE orgId=? AND id=?",
  )
    .bind(Date.now(), f.orgId, f.create.requestId)
    .run();
  const archive = await archiveCommand(f, true);
  const first = await apply(f, archive);
  const restore = await archiveCommand(f, false);
  const restored = await apply(f, restore);
  expect(Date.parse(restored.result.item!.updatedAt)).toBeGreaterThan(
    Date.parse(first.result.item!.updatedAt),
  );
  expect((await apply(f, restore)).result.outcome).toBe("applied");
  expect((await apply(f, archive)).result).toMatchObject({
    outcome: "superseded",
    item: { archivedAt: null },
  });
});
it("a completed creation receipt survives item removal and cannot resurrect it", async () => {
  const f = await fixture(),
    data = command(f);
  await apply(f, data);
  await getPrisma().showInventoryItem.delete({ where: { id: data.requestId } });
  expect((await apply(f, data)).result).toMatchObject({
    outcome: "removed",
    item: null,
  });
  expect(await f.row(data.requestId)).toBeNull();
});
it("review fences an undelivered write and racing review/apply has one outcome", async () => {
  const f = await fixture(),
    data = command(f);
  expect((await apply(f, data, "review")).result.outcome).toBe("cancelled");
  expect((await apply(f, data)).result.outcome).toBe("cancelled");
  expect(await f.row(data.requestId)).toBeNull();
  const next = { ...data, requestId: crypto.randomUUID() };
  const replies = await Promise.all([apply(f, next), apply(f, next, "review")]);
  expect(replies[0].result.outcome).toBe(replies[1].result.outcome);
  expect(
    await getPrisma().showInventoryItem.count({ where: { orgId: f.orgId } }),
  ).toBe(replies[0].result.outcome === "applied" ? 1 : 0);
});
it("rejects account, payload and organization mismatches and revoked receipt access", async () => {
  const f = await fixture(),
    data = command(f);
  await apply(f, data);
  await expect(apply(f, { ...data, userId: "another" })).rejects.toThrow(
    "account changed",
  );
  if (data.operation.kind !== "create") throw new Error("fixture");
  await expect(
    apply(f, { ...data, operation: { ...data.operation, name: "Different" } }),
  ).rejects.toThrow("different details");
  const other = await actorFixture();
  await expect(writeShowInventory(data, other.headers)).rejects.toThrow();
  const foreign = { ...data, orgId: other.orgId, userId: other.userId };
  expect(
    (await writeShowInventory(foreign, other.headers)).result,
  ).toMatchObject({ outcome: "conflict", item: null });
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?")
    .bind(f.orgId, f.userId)
    .run();
  await expect(apply(f, data)).rejects.toThrow("permission");
});
it("native create/archive/restore retries share the guarded receipts without changing native request bodies", async () => {
  const f = await fixture();
  const post = async (path: string, body: unknown) => {
    const response = await handleMobileApi(
      new Request(
        `https://app.showpilot.tech/api/mobile/v1/schedule/${path}?orgId=${f.orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: f.headers.get("cookie")!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
      { DB: env.DB },
    );
    if (!response) throw new Error("Missing native response");
    return response;
  };
  const created = await post("inventory", f.create);
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    id: f.create.requestId,
    created: true,
  });
  const again = await post("inventory", f.create);
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({
    id: f.create.requestId,
    created: false,
  });
  const row = await f.row(f.create.requestId),
    archive = { expectedUpdatedAt: row!.updatedAt.toISOString() };
  let response = await post(`inventory/${f.create.requestId}/archive`, archive);
  expect(response.status).toBe(200);
  await response.body?.cancel();
  const archived = await f.row(f.create.requestId);
  response = await post(`inventory/${f.create.requestId}/restore`, {
    expectedUpdatedAt: archived!.updatedAt.toISOString(),
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  response = await post(`inventory/${f.create.requestId}/archive`, archive);
  expect(response.status).toBe(200);
  await response.body?.cancel();
  expect((await f.row(f.create.requestId))?.archivedAt).toBeNull();
});
