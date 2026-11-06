import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { withRelayMember } from "@/test/relay-fixtures";
import type { RundownItem } from "@/types/rundown";
import { getRundownStateForOrg, persistRundownItemsForOrg } from "../rundown";
import { migrateRundownItemSnapshot } from "../rundown-item-storage.server";

// Supply only the framework request adapter; persistence uses real D1 and DOs.
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (validator: typeof validate) => { validate = validator; return chain; },
      handler: (handler: (input: unknown) => unknown) => async (input: { data?: unknown } = {}) => handler({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});

afterEach(() => abortAllDurableObjects());
const serviceDate = "2026-11-05";
const item = (index: number): RundownItem => ({ id: `cue-${index}`, title: `Cue ${index}`, type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: index, hardStop: false });
async function fixture() {
  const orgId = crypto.randomUUID();
  const showId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?, 'Persistence', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  await env.DB.prepare("INSERT INTO rundown (id,orgId,serviceDate,name) VALUES (?, ?, ?, 'Persistence show')").bind(showId, orgId, serviceDate).run();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS persistence_audit (orgId TEXT, itemId TEXT, operation TEXT)"),
    env.DB.prepare("CREATE TRIGGER IF NOT EXISTS persistence_updated AFTER UPDATE ON rundown_item BEGIN INSERT INTO persistence_audit VALUES (NEW.orgId, NEW.itemId, 'update'); END"),
    env.DB.prepare("CREATE TRIGGER IF NOT EXISTS persistence_inserted AFTER INSERT ON rundown_item BEGIN INSERT INTO persistence_audit VALUES (NEW.orgId, NEW.itemId, 'insert'); END"),
    env.DB.prepare("CREATE TRIGGER IF NOT EXISTS persistence_deleted AFTER DELETE ON rundown_item BEGIN INSERT INTO persistence_audit VALUES (OLD.orgId, OLD.itemId, 'delete'); END"),
  ]);
  const stub = env.RUNDOWN_RELAY.getByName(`${orgId}:${showId}`);
  const url = await withRelayMember(`https://rundown.test/command?orgId=${orgId}&showId=${showId}&serviceDate=${serviceDate}&access=edit`);
  return { orgId, showId, stub,
    async command(action: string, payload: unknown, status = 200) {
      const commandUrl = new URL(url);
      if (action.startsWith("timer-")) commandUrl.searchParams.set("access", "control");
      const response = await stub.fetch(commandUrl, { method: "POST", body: JSON.stringify({ action, payload }) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: status === 200 });
    },
    async rows() { return (await env.DB.prepare("SELECT * FROM rundown_item WHERE orgId = ? AND showId = ? ORDER BY sortOrder").bind(orgId, showId).all()).results; },
    async state() { const stateUrl = new URL(url); stateUrl.pathname = "/state"; return (await stub.fetch(stateUrl)).json<{ items: RundownItem[]; ppSlide: unknown }>(); },
    async clearAudit() { await env.DB.prepare("DELETE FROM persistence_audit WHERE orgId = ?").bind(orgId).run(); },
    async audit() { return (await env.DB.prepare("SELECT itemId, operation FROM persistence_audit WHERE orgId = ? ORDER BY rowid").bind(orgId).all()).results; },
  };
}

it("updates only the changed row in a 100-item rundown and does not write a JSON item snapshot", async () => {
  const f = await fixture();
  await f.command("seed", { items: Array.from({ length: 100 }, (_, i) => item(i)) });
  const before = await f.rows();
  await f.clearAudit();
  await f.command("update-item", { id: "cue-42", updates: { title: "Changed cue" } });
  const after = await f.rows();
  expect(after.map(row => row.id)).toEqual(before.map(row => row.id));
  expect(after.filter(row => row.itemId !== "cue-42")).toEqual(before.filter(row => row.itemId !== "cue-42"));
  expect(after[42].title).toBe("Changed cue");
  expect(await f.audit()).toEqual([{ itemId: "cue-42", operation: "update" }]);
  expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?").bind(f.orgId, `rundown-items:${f.showId}`).first()).toBeNull();
});

it("persists and edits a rundown larger than the old 1.5 MB boundary through relay eviction", async () => {
  const f = await fixture();
  const items = Array.from({ length: 150 }, (_, i) => ({ ...item(i), notes: "n".repeat(20000) }));
  expect(new TextEncoder().encode(JSON.stringify(items)).byteLength).toBeGreaterThan(3_000_000);
  await f.command("seed", { items });
  await f.command("update-item", { id: "cue-42", updates: { title: "Large rundown edit" } });
  await evictDurableObject(f.stub);
  const restored = await f.state();
  expect(restored.items).toHaveLength(150);
  expect(restored.items[42]).toMatchObject({ title: "Large rundown edit", notes: items[42].notes });
  expect(await f.rows()).toHaveLength(150);
});

it("persists setup/import row diffs and all scheduling/actual timestamps without a fallback snapshot", async () => {
  const f = await fixture();
  const items = Array.from({ length: 100 }, (_, i) => item(i));
  const dates = { scheduledStart: "2026-11-05T10:00:00.000Z", expectedEnd: "2026-11-05T10:01:00.000Z", actualStart: "2026-11-05T10:00:02.000Z", actualEnd: "2026-11-05T10:01:03.000Z" };
  items[42] = { ...items[42], ...dates };
  await persistRundownItemsForOrg(f.orgId, serviceDate, items, f.showId);
  await f.clearAudit();
  items[42] = { ...items[42], title: "Edited import" };
  await persistRundownItemsForOrg(f.orgId, serviceDate, items, f.showId);
  expect(await f.audit()).toEqual([{ itemId: "cue-42", operation: "update" }]);
  expect((await getRundownStateForOrg({ orgId: f.orgId, showId: f.showId, serviceDate })).items[42]).toMatchObject({ ...dates, title: "Edited import" });
});

it("migrates legacy snapshots once and never resurrects them after a clear", async () => {
  const f = await fixture();
  const scope = { orgId: f.orgId, showId: f.showId, serviceDate };
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), f.orgId, `rundown-items:${serviceDate}`, JSON.stringify([item(0)])).run();
  const migrated = await getRundownStateForOrg(scope);
  expect(migrated.items).toHaveLength(1);
  expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?").bind(f.orgId, `rundown-items:${serviceDate}`).first()).toBeNull();
  await f.command("seed", { items: migrated.items });
  await f.command("clear-all", {});
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), f.orgId, `rundown-items:${serviceDate}`, JSON.stringify([item(0)])).run();
  expect((await getRundownStateForOrg(scope)).items).toEqual([]);
  // A migration already in flight when clear committed must also be harmless.
  await migrateRundownItemSnapshot(env.DB, scope, [item(0)]);
  expect((await getRundownStateForOrg(scope)).items).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("writes deletes and shifted order only once, then leaves untouched rows alone on later edits", async () => {
  const f = await fixture();
  await f.command("seed", { items: [item(0), item(1), item(2)] });
  await f.clearAudit();
  await f.command("remove-item", { id: "cue-0" });
  expect(await f.audit()).toEqual([{ itemId: "cue-0", operation: "delete" }, { itemId: "cue-1", operation: "update" }, { itemId: "cue-2", operation: "update" }]);
  await f.clearAudit();
  await f.command("update-item", { id: "cue-1", updates: { title: "Updated" } });
  expect(await f.audit()).toEqual([{ itemId: "cue-1", operation: "update" }]);
  await f.command("restore-item", { id: "cue-0" });
  expect((await f.state()).items.map(row => row.id)).toEqual(["cue-0", "cue-1", "cue-2"]);
});

it("keeps same-date shows separate and leaves the first show's legacy snapshot for its own migration", async () => {
  const f = await fixture();
  const secondId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO rundown (id,orgId,serviceDate,name,createdAt) VALUES (?, ?, ?, 'Second show', '2099-01-01')").bind(secondId, f.orgId, serviceDate).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), f.orgId, `rundown-items:${serviceDate}`, JSON.stringify([item(0)])).run();
  await persistRundownItemsForOrg(f.orgId, serviceDate, [item(1)], secondId);
  expect((await getRundownStateForOrg({ orgId: f.orgId, serviceDate, showId: f.showId })).items.map(row => row.id)).toEqual(["cue-0"]);
  await persistRundownItemsForOrg(f.orgId, serviceDate, [], f.showId);
  expect((await getRundownStateForOrg({ orgId: f.orgId, serviceDate, showId: secondId })).items.map(row => row.id)).toEqual(["cue-1"]);
});

it("writes only the two affected rows on a live timer advance", async () => {
  const f = await fixture();
  await f.command("seed", { items: [item(0), item(1), item(2)] });
  await f.command("timer-start", { itemId: "cue-0" });
  await f.clearAudit();
  await f.command("timer-next", {});
  expect(await f.audit()).toEqual([{ itemId: "cue-0", operation: "update" }, { itemId: "cue-1", operation: "update" }]);
  expect((await f.rows()).map(row => row.status)).toEqual(["complete", "live", "upcoming"]);
});

it("rolls back failed row batches without acknowledging new relay state", async () => {
  const f = await fixture();
  await f.command("seed", { items: [item(0), item(1)] });
  const before = await f.rows();
  await env.DB.prepare("CREATE TRIGGER reject_persistence_update BEFORE UPDATE ON rundown_item WHEN NEW.title = 'Injected write failure' BEGIN SELECT RAISE(ABORT, 'Injected write failure'); END").run();
  await expect(persistRundownItemsForOrg(f.orgId, serviceDate, [{ ...item(0), title: "Uncommitted change" }, { ...item(1), title: "Injected write failure" }], f.showId)).rejects.toThrow();
  expect(await f.rows()).toEqual(before);
  await f.command("update-item", { id: "cue-1", updates: { title: "Injected write failure" } }, 400);
  await expect.poll(async () => (await env.DB.prepare("SELECT source,code FROM operational_error WHERE orgId=?").bind(f.orgId).all()).results)
    .toEqual([{ source: "RundownRelay", code: "rundown_persistence" }]);
  expect(await f.rows()).toEqual(before);
  expect((await f.state()).items[1].title).toBe("Cue 1");
  await env.DB.prepare("DROP TRIGGER reject_persistence_update").run();
  await f.command("update-item", { id: "cue-1", updates: { title: "Retry succeeded" } });
  expect((await f.rows())[1].title).toBe("Retry succeeded");
});

it("reads an old durable snapshot and atomically converts it to item values on the next command", async () => {
  const f = await fixture();
  await f.command("seed", { items: [item(0)] });
  const items = (await f.state()).items;
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    const stored = await ctx.storage.get<Record<string, unknown>>("state");
    if (!stored) throw new Error("Missing state");
    delete stored.itemIds;
    await ctx.storage.put("state", { ...stored, items });
    await ctx.storage.delete("rundown-item:cue-0");
  });
  await evictDurableObject(f.stub);
  expect((await f.state()).items).toEqual(items);
  await f.command("stage-message", { message: "Migrated" });
  await evictDurableObject(f.stub);
  expect((await f.state()).items).toEqual(items);
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    expect(await ctx.storage.get("state")).toMatchObject({ itemIds: ["cue-0"] });
    expect(await ctx.storage.get("state")).not.toHaveProperty("items");
  });
});

it("persists current ProPresenter output for direct slide, preview and output-toggle commands", async () => {
  const f = await fixture();
  await f.command("pp-output-enabled", { enabled: true });
  const slide = { text: "Current lyrics", notes: "", presentationName: "Song", isScripture: false };
  await f.command("pp-slide", { slide });
  await evictDurableObject(f.stub);
  expect((await f.state()).ppSlide).toMatchObject(slide);
  await f.command("pp-preview", { slide: { ...slide, text: "Next verse" } });
  await evictDurableObject(f.stub);
  expect((await f.state()).ppSlide).toMatchObject({ text: "Next verse" });
  await f.command("pp-output-enabled", { enabled: false });
  await evictDurableObject(f.stub);
  expect((await f.state()).ppSlide).toBeNull();
});
