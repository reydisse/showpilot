import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { TestRundownRelay } from "@/test/worker-entry";
import { rundownRelayKey } from "../rundown-relay-key";
import { rundownInternalRequest } from "../rundown-internal-request.server";

afterEach(() => abortAllDurableObjects());
const item = (title: string) => ({ id: "cue", title, type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false });

async function fixture() {
  const orgId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Activation',?,CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  const shows = await Promise.all(["2026-11-05", "2026-11-06"].map(async serviceDate => {
    const showId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO rundown (id,orgId,serviceDate,name) VALUES (?,?,?,'Activation show')").bind(showId, orgId, serviceDate).run();
    const stub = env.RUNDOWN_RELAY.getByName(rundownRelayKey(orgId, serviceDate, serviceDate, showId));
    const query = new URLSearchParams({ orgId, showId, serviceDate, access: "control" });
    const request = (path: string, action?: string, payload?: unknown) => rundownInternalRequest(`https://rundown.test${path}?${query}`, env.BETTER_AUTH_SECRET,
      action ? { method: "POST", body: JSON.stringify({ action, payload }) } : undefined);
    return {
      stub, showId, serviceDate, request,
      activate: (title = serviceDate) => stub.fetch(request("/activate", "seed", { items: [item(title)] })),
      command: (action: string, payload?: unknown) => stub.fetch(request("/command", action, payload)),
      state: async () => (await stub.fetch(request("/state"))).json<{ showId: string; serviceDate: string; initialized: boolean; items: Array<{ title: string }> }>(),
      control: (action: "hold" | "release" | "waiting") => runInDurableObject(stub, async instance => {
        if (!(instance instanceof TestRundownRelay)) throw new Error("Missing test gate");
        if (action === "hold") instance.holdNextBatch();
        if (action === "release") instance.releaseBatch();
        return instance.isBatchWaiting();
      }),
    };
  }));
  const pointer = async () => Object.fromEntries((await env.DB.prepare("SELECT key,value FROM app_setting WHERE orgId=? AND key IN ('active-show-id','active-service-date')").bind(orgId).all<{ key: string; value: string }>()).results.map(row => [row.key, row.value]));
  const [a, b] = shows;
  return { orgId, a, b, pointer };
}

async function accepted(response: Response) { expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true }); }

it("publishes a saved room and both pointer fields together, surviving eviction", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await accepted(await f.b.command("seed", { items: [item("Live edit wins")] }));
  await f.b.control("hold");
  const activation = f.b.activate("Stale loader").then(response => response);
  try {
    await expect.poll(() => f.b.control("waiting")).toBe(true);
    expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
    // The room must already be durable before the pointer commit can begin.
    await runInDurableObject(f.b.stub, async (_instance, ctx) => {
      expect(await ctx.storage.get("state")).toMatchObject({ initialized: true, showId: f.b.showId, itemIds: ["cue"] });
      expect(await ctx.storage.get("rundown-item:cue")).toMatchObject({ title: "Live edit wins" });
    });
  } finally { await f.b.control("release"); }
  expect(await (await activation).json()).toMatchObject({ ok: true, showId: f.b.showId, serviceDate: f.b.serviceDate });
  expect(await f.pointer()).toEqual({ "active-show-id": f.b.showId, "active-service-date": f.b.serviceDate });
  await evictDurableObject(f.b.stub);
  expect(await f.b.state()).toMatchObject({ showId: f.b.showId, items: [{ title: "Live edit wins" }] });
});

it("rolls back both pointer fields when the second pointer write fails, then retries the prepared room", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await env.DB.prepare("CREATE TRIGGER reject_active_date BEFORE INSERT ON app_setting WHEN NEW.key='active-service-date' AND NEW.value='2026-11-06' BEGIN SELECT RAISE(ABORT, 'Injected pointer failure'); END").run();
  const failed = await f.b.activate();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ ok: false, showId: f.b.showId, serviceDate: f.b.serviceDate });
  expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
  await env.DB.prepare("DROP TRIGGER reject_active_date").run();
  await evictDurableObject(f.b.stub);
  await accepted(await f.b.activate("Stale retry"));
  expect((await f.b.state()).items[0].title).toBe(f.b.serviceDate);
  expect(await f.pointer()).toEqual({ "active-show-id": f.b.showId, "active-service-date": f.b.serviceDate });
});

it("keeps the old target when preparation fails, and does not overwrite intentional empty state", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await env.DB.prepare("CREATE TRIGGER reject_active_seed BEFORE INSERT ON rundown_item WHEN NEW.title='Rejected seed' BEGIN SELECT RAISE(ABORT, 'Injected seed failure'); END").run();
  const failed = await f.b.activate("Rejected seed");
  expect(failed.status).toBe(503); await failed.text();
  expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
  await accepted(await f.b.command("clear-all"));
  await accepted(await f.b.activate("Old loader cue"));
  expect((await f.b.state()).items).toEqual([]);
});

it("does not change the active show when a different show's timer starts", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await accepted(await f.b.activate());
  const started = await f.a.command("timer-start", { itemId: "cue" });
  expect(await started.json()).toMatchObject({ ok: true, showId: f.a.showId, serviceDate: f.a.serviceDate });
  expect(await f.pointer()).toEqual({ "active-show-id": f.b.showId, "active-service-date": f.b.serviceDate });
});

it.each(["deleted", "rescheduled", "deleting"])("rejects publication if the prepared show is %s before the commit", async condition => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await accepted(await f.b.command("seed", { items: [item("Prepared")] }));
  await f.b.control("hold");
  const activation = f.b.activate().then(response => response);
  try {
    await expect.poll(() => f.b.control("waiting")).toBe(true);
    if (condition === "deleted") await env.DB.prepare("DELETE FROM rundown WHERE orgId=? AND id=?").bind(f.orgId, f.b.showId).run();
    if (condition === "rescheduled") await env.DB.prepare("UPDATE rundown SET serviceDate='2026-12-01' WHERE orgId=? AND id=?").bind(f.orgId, f.b.showId).run();
    if (condition === "deleting") await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,'deleting')").bind(crypto.randomUUID(), f.orgId, `show-deleting:${f.b.showId}`).run();
  } finally { await f.b.control("release"); }
  const response = await activation; expect(response.status).toBe(503); await response.text();
  expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
});

it("requires internal authority and refuses forced replacement during activation", async () => {
  const f = await fixture();
  const request = f.a.request("/activate", "seed", { items: [item("Unsafe")], force: true });
  const forced = await f.a.stub.fetch(request); expect(forced.status).toBe(400); await forced.text();
  const forged = f.b.request("/activate", "seed", { items: [] }); forged.headers.delete("x-showpilot-internal-secret");
  const denied = await f.b.stub.fetch(forged); expect(denied.status).toBe(401); await denied.text();
  expect(await f.pointer()).toEqual({});
});

it("does not publish a target when its durable room preparation fails", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await accepted(await f.b.command("seed", { items: [item("Prepared")] }));
  await runInDurableObject(f.b.stub, async (_instance, ctx) => {
    vi.spyOn(ctx.storage, "transaction").mockRejectedValueOnce(new Error("Injected durable storage failure"));
  });
  try {
    const response = await f.b.activate();
    expect(response.status).toBe(503); await response.text();
    expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
  } finally { vi.restoreAllMocks(); }
  await accepted(await f.b.activate());
  expect(await f.pointer()).toEqual({ "active-show-id": f.b.showId, "active-service-date": f.b.serviceDate });
});

it("activates a rescheduled stable show without replacing its live cues", async () => {
  const f = await fixture();
  await accepted(await f.a.activate("Keep this live edit"));
  const date = "2026-12-01";
  await env.DB.prepare("UPDATE rundown SET serviceDate=? WHERE orgId=? AND id=?").bind(date, f.orgId, f.a.showId).run();
  const old = f.a.request("/activate", "seed", { items: [item("Stale loader")] });
  const url = new URL(old.url); url.searchParams.set("serviceDate", date);
  const response = await f.a.stub.fetch(new Request(url, old));
  expect(await response.json()).toMatchObject({ ok: true, showId: f.a.showId, serviceDate: date });
  expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": date });
  expect((await f.a.state()).items[0].title).toBe("Keep this live edit");
});

it("keeps pointer pairs consistent when two show activations commit in reverse request order", async () => {
  const f = await fixture();
  await accepted(await f.a.activate());
  await f.a.control("hold");
  const delayed = f.a.activate().then(response => response);
  try {
    await expect.poll(() => f.a.control("waiting")).toBe(true);
    await accepted(await f.b.activate());
    expect(await f.pointer()).toEqual({ "active-show-id": f.b.showId, "active-service-date": f.b.serviceDate });
  } finally { await f.a.control("release"); }
  await accepted(await delayed);
  expect(await f.pointer()).toEqual({ "active-show-id": f.a.showId, "active-service-date": f.a.serviceDate });
});
