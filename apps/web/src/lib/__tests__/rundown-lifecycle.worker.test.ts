import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { withRelayMember } from "@/test/relay-fixtures";
import { TestRundownRelay } from "@/test/worker-entry";

afterEach(() => abortAllDurableObjects());

async function fixture() {
  const orgId = crypto.randomUUID();
  const serviceDate = "2026-11-05";
  const stub = env.RUNDOWN_RELAY.getByName(`${orgId}:${serviceDate}`);
  const base = await withRelayMember(`https://rundown.test/command?orgId=${orgId}&serviceDate=${serviceDate}&access=edit`);
  const url = (path: string) => { const result = new URL(base); result.pathname = path; return result; };
  const command = (title: string) => stub.fetch(url("/command"), {
    method: "POST", body: JSON.stringify({ action: "update-item", payload: { id: "cue", updates: { title } } }),
  });
  const seeded = await stub.fetch(url("/command"), { method: "POST", body: JSON.stringify({ action: "seed", payload: { items: [
    { id: "cue", title: "Saved cue", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false },
  ] } }) });
  expect(seeded.status).toBe(200); await seeded.text();
  const control = (action: "hold" | "waiting" | "release") => runInDurableObject(stub, async instance => {
    if (!(instance instanceof TestRundownRelay)) throw new Error("Missing test batch gate");
    if (action === "hold") instance.holdNextBatch();
    if (action === "release") instance.releaseBatch();
    return instance.isBatchWaiting();
  });
  return { orgId, stub, url, command, control };
}

it.each(["state", "socket"])("does not expose or persist a rejected edit through concurrent %s hydration", async transport => {
  const f = await fixture();
  await env.DB.prepare("CREATE TRIGGER IF NOT EXISTS reject_lifecycle_edit BEFORE UPDATE OF title ON rundown_item WHEN NEW.title = 'Rejected cue' BEGIN SELECT RAISE(ABORT, 'Injected real D1 failure'); END").run();
  await f.control("hold");
  const edit = f.command("Rejected cue").then(response => response);
  await expect.poll(() => f.control("waiting")).toBe(true);
  // A reconnect reconciles this setting. It must not save the tentative edit.
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'propresenter-stage-display','true')").bind(crypto.randomUUID(), f.orgId).run();
  let socket: WebSocket | null = null;
  const read = (async () => {
    if (transport === "state") return (await f.stub.fetch(f.url("/state"))).json<{ items: Array<{ title: string }> }>();
    const response = await f.stub.fetch(f.url("/ws"), { headers: { Upgrade: "websocket" } });
    socket = response.webSocket;
    if (!socket) throw new Error("Missing socket");
    const hydrated = new Promise<{ state: { items: Array<{ title: string }> } }>(resolve => {
      socket?.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true });
    });
    socket.accept();
    return (await hydrated).state;
  })();
  // Give the competing request a chance to reach its storage operations while
  // the command remains suspended at D1. Completion must still show committed data.
  try { await Promise.race([read, new Promise(resolve => setTimeout(resolve, 100))]); }
  finally { await f.control("release"); }
  const editResponse = await edit; expect(editResponse.status).toBe(400); await editResponse.text();
  const observed = await read;
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    for (const connected of ctx.getWebSockets()) connected.close(1000, "Test complete");
  });
  await evictDurableObject(f.stub);
  const restored = await (await f.stub.fetch(f.url("/state"))).json<{ items: Array<{ title: string }> }>();
  expect({ observed: observed.items[0].title, restored: restored.items[0].title }).toEqual({ observed: "Saved cue", restored: "Saved cue" });
  expect(await env.DB.prepare("SELECT title FROM rundown_item WHERE orgId=?").bind(f.orgId).first()).toEqual({ title: "Saved cue" });
});

it.each(["purge-show", "purge-org"])("serializes %s after an in-flight edit so the room cannot resurrect", async operation => {
  const f = await fixture();
  await f.control("hold");
  const edit = f.command("Saved before deletion").then(response => response);
  await expect.poll(() => f.control("waiting")).toBe(true);
  let purgedWhileWritePending = false;
  const purge = f.stub.fetch(f.url(`/internal/${operation}`), {
    method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
  }).then(response => { purgedWhileWritePending = true; return response; });
  let completedBeforeRelease = false;
  try { await Promise.race([purge, new Promise(resolve => setTimeout(resolve, 100))]); completedBeforeRelease = purgedWhileWritePending; }
  finally { await f.control("release"); }
  const editResponse = await edit; expect(editResponse.status).toBe(200); await editResponse.text();
  const purgeResponse = await purge; expect(purgeResponse.status).toBe(200); await purgeResponse.text();
  expect(completedBeforeRelease).toBe(false);
  await evictDurableObject(f.stub);
  const observer = f.url("/state"); observer.searchParams.set("access", "observe");
  expect(await (await f.stub.fetch(observer)).json()).toMatchObject({ initialized: false, items: [], showId: null, serviceDate: null });
  expect(await runInDurableObject(f.stub, async (_instance, ctx) => ctx.storage.get("rundown-item:cue"))).toBeUndefined();
});
