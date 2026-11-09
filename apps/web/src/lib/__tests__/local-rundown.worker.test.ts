import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { withRelayMember } from "@/test/relay-fixtures";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const orgId = crypto.randomUUID();
  const showId = crypto.randomUUID();
  const serviceDate = "2026-11-06";
  const base = await withRelayMember(`https://rundown.test/command?orgId=${orgId}&showId=${showId}&serviceDate=${serviceDate}&access=control`);
  await env.DB.prepare("INSERT INTO rundown (id, orgId, serviceDate, name) VALUES (?, ?, ?, 'Local fixture')").bind(showId, orgId, serviceDate).run();
  const stub = env.RUNDOWN_RELAY.getByName(`${orgId}:${showId}`);
  const url = (path: string) => { const url = new URL(base); url.pathname = path; return url; };
  const command = (body: unknown, access = "control") => { const target = url("/command"); target.searchParams.set("access", access); return stub.fetch(target, { method: "POST", body: JSON.stringify(body) }); };
  const seed = await command({ action: "seed", payload: { items: ["a", "b"].map((id, sortOrder) => ({ id, title: `Cue ${id}`, type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder, hardStop: false })) } });
  expect(seed.status).toBe(200);
  const seeded = await seed.json<{ revision: number }>();
  const startedAt = Date.now() - 60000;
  const payload = { version: 1, sessionId: crypto.randomUUID(), orgId, showId, serviceDate, baseRevision: seeded.revision, startedAt, endedAt: startedAt + 50000,
    operations: [
      { at: startedAt, action: "timer-start", payload: { itemId: "a" } },
      { at: startedAt + 20000, action: "timer-next" },
    ] };
  const body = { action: "reconcile-local", id: `local:${payload.sessionId}`, expectedRevision: payload.baseRevision, payload };
  const state = async () => {
    const value = await (await stub.fetch(url("/state"))).json<{ revision: number; timer: { playback: string; currentItemId: string | null; elapsed: number; serverTime: number }; items: Array<{ id: string; status: string; actualStart?: string; actualEnd?: string }> }>();
    const { serverTime: _serverTime, ...timer } = value.timer;
    return { ...value, timer };
  };
  return { orgId, showId, stub, command, state, body, payload };
}

it("applies local progress once, persists actual times, and holds the reconciled clock through eviction", async () => {
  const test = await fixture();
  const response = await test.command(test.body);
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const applied = await test.state();
  expect(applied.timer).toMatchObject({ playback: "pause", currentItemId: "b", elapsed: 30000 });
  expect(applied.items[0]).toMatchObject({ status: "complete", actualEnd: new Date(test.payload.startedAt + 20000).toISOString() });
  expect(applied.items[1]).toMatchObject({ status: "live", actualStart: new Date(test.payload.startedAt + 20000).toISOString() });
  expect(applied.revision).toBe(test.payload.baseRevision + 1);
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ timer: applied.timer, items: applied.items, revision: applied.revision });
  const duplicate = await test.command(test.body);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ duplicate: true, revision: applied.revision });
  const rows = await env.DB.prepare("SELECT itemId, status, actualEnd FROM rundown_item WHERE orgId=? AND showId=? ORDER BY sortOrder").bind(test.orgId, test.showId).all();
  expect(rows.results[0]).toMatchObject({ itemId: "a", status: "complete", actualEnd: applied.items[0].actualEnd });
});

it("returns a revision conflict after another operator changes the show and preserves both journals", async () => {
  const test = await fixture();
  const edit = await test.command({ action: "timer-start", payload: { itemId: "b" } });
  expect(edit.status).toBe(200); await edit.arrayBuffer();
  const before = await test.state();
  const conflict = await test.command(test.body);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ reason: "revision-conflict", revision: before.revision });
  expect(await test.state()).toMatchObject(before);
  expect(test.payload.operations).toHaveLength(2);
});

it("rejects edits-only authority, missing revision guards, wrong show identity, and device replay", async () => {
  const test = await fixture();
  const before = await test.state();
  const invalid = [
    { ...test.body, expectedRevision: undefined },
    { ...test.body, id: "unstable-id" },
    { ...test.body, payload: { ...test.payload, orgId: "another-org" } },
    { ...test.body, payload: { ...test.payload, showId: "another-show" } },
    { ...test.body, payload: { ...test.payload, operations: [{ at: test.payload.startedAt, action: "device-action", payload: { command: "cut" } }] } },
    { ...test.body, payload: { ...test.payload, operations: [...test.payload.operations, { at: test.payload.startedAt, action: "timer-next" }] } },
  ];
  const forbidden = await test.command(test.body, "edit");
  expect(forbidden.status).toBe(400); await forbidden.arrayBuffer();
  for (const body of invalid) {
    const rejected = await test.command(body);
    expect(rejected.status).toBe(400); await rejected.arrayBuffer();
  }
  expect(await test.state()).toMatchObject(before);
});

it("rolls back local reconciliation on D1 failure and permits the same journal to retry", async () => {
  const test = await fixture();
  const before = await test.state();
  await env.DB.prepare("CREATE TRIGGER reject_local_progress BEFORE UPDATE OF status ON rundown_item WHEN NEW.itemId='a' AND NEW.status='complete' BEGIN SELECT RAISE(ABORT, 'Injected local reconciliation failure'); END").run();
  const failed = await test.command(test.body);
  expect(failed.status).toBe(400); await failed.arrayBuffer();
  expect(await test.state()).toMatchObject(before);
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject(before);
  await env.DB.prepare("DROP TRIGGER reject_local_progress").run();
  const retry = await test.command(test.body);
  expect(retry.status).toBe(200); await retry.arrayBuffer();
  expect(await test.state()).toMatchObject({ revision: before.revision + 1, timer: { playback: "pause", currentItemId: "b", elapsed: 30000 } });
});
