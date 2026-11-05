import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { SerialCommandExecutor } from "@/lib/serial-command-executor";
import { rundownInternalRequest } from "@/lib/rundown-internal-request.server";
import { RUNDOWN_PIN_HEADER, RUNDOWN_PIN_SETTING_KEY } from "@/lib/rundown-pin.server";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const orgId = `rundown-authority-${crypto.randomUUID()}`;
  const authority = await seedRelayMember(orgId);
  const stub = env.RUNDOWN_RELAY.getByName(`${orgId}:2026-11-05`);
  const url = (path: string, claimed = true) => {
    const url = new URL(`https://rundown.test${path}`);
    url.search = new URLSearchParams({ orgId, serviceDate: "2026-11-05", access: "control" }).toString();
    if (claimed) {
      url.searchParams.set("authUserId", authority.userId);
      url.searchParams.set("authSessionId", authority.sessionId);
    }
    return url;
  };
  const command = (url: URL) => stub.fetch(url, { method: "POST", body: JSON.stringify({ action: "stage-message", payload: { message: "Fixture message" } }) });
  return { orgId, authority, stub, url, command };
}

describe("RundownRelay live authority", () => {
  async function pinProtectedFixture() {
    const test = await fixture();
    await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    // Independently generated Node PBKDF2 fixture at the production work factor.
    const pin = "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";
    await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)").bind(crypto.randomUUID(), test.orgId, RUNDOWN_PIN_SETTING_KEY, pin).run();
    return test;
  }

  it("requires the current PIN for a technical manager's HTTP command", async () => {
    const test = await pinProtectedFixture();
    const denied = await test.command(test.url("/command"));
    expect(denied.status).toBe(401); await denied.text();
    const accepted = await test.stub.fetch(test.url("/command"), { method: "POST", headers: { [RUNDOWN_PIN_HEADER]: "2468" }, body: '{"action":"stage-message","payload":{"message":"PIN protected"}}' });
    expect(accepted.status).toBe(200); await accepted.text();
    expect(await (await test.stub.fetch(test.url("/state", false))).json()).toMatchObject({ stageMessage: "PIN protected" });
  }, 30000);

  it("rejects a previously PIN-authorized socket after PIN rotation", async () => {
    const test = await pinProtectedFixture();
    const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket", [RUNDOWN_PIN_HEADER]: "2468" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing PIN-authorized socket");
    const hydrated = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
    socket.accept(); await hydrated;
    await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key=?").bind("pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:y3Naihn0jaG2wHtict2bDNzjCpnFJHzB5e-PAeC8rqg", test.orgId, RUNDOWN_PIN_SETTING_KEY).run();
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "command", action: "stage-message", payload: { message: "Rejected after rotation" } }));
    expect(await closed).toMatchObject({ code: 4403 });
    expect(await (await test.stub.fetch(test.url("/state", false))).json()).toMatchObject({ stageMessage: "" });
  }, 30000);

  it.each(["http", "socket"])("checks authority when a queued %s command executes", async transport => {
    const test = await fixture();
    await (await test.command(test.url("/command"))).text();
    let socket: WebSocket | undefined;
    if (transport === "socket") {
      const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
      socket = response.webSocket ?? undefined;
      if (!socket) throw new Error("Missing operator socket");
      const hydrate = new Promise(resolve => socket?.addEventListener("message", resolve, { once: true }));
      socket.accept(); await hydrate;
    }
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let heldTail: unknown;
    await runInDurableObject(test.stub, async (instance, ctx) => {
      const executor: unknown = Reflect.get(instance, "commands");
      if (!(executor instanceof SerialCommandExecutor)) throw new Error("Missing production command executor");
      ctx.waitUntil(executor.run(() => gate));
      heldTail = Reflect.get(executor, "tail");
    });
    const pending = socket
      ? new Promise<number>(resolve => {
          socket.addEventListener("close", event => resolve(event.code), { once: true });
          socket.send(JSON.stringify({ type: "command", action: "stage-clear" }));
        })
      : test.stub.fetch(test.url("/command"), { method: "POST", body: '{"action":"stage-clear"}' }).then(async response => {
          await response.text(); return response.status;
        });
    try {
      await expect.poll(() => runInDurableObject(test.stub, async instance => {
        const executor: unknown = Reflect.get(instance, "commands");
        if (!(executor instanceof SerialCommandExecutor)) throw new Error("Missing production command executor");
        return Reflect.get(executor, "tail") !== heldTail;
      })).toBe(true);
      await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    } finally {
      release?.();
    }
    expect(await pending).toBe(transport === "socket" ? 4403 : 401);
    expect(await (await test.stub.fetch(test.url("/state", false))).json()).toMatchObject({ stageMessage: "Fixture message" });
  });

  it("accepts only explicit secret-protected internal commands and state reads", async () => {
    const test = await fixture();
    const body = JSON.stringify({ action: "stage-message", payload: { message: "Automation" } });
    const forged = await test.stub.fetch(test.url("/internal/command", false), { method: "POST", headers: { "x-showpilot-internal-secret": "wrong" }, body });
    expect(forged.status).toBe(401); await forged.text();
    const publicAttempt = await test.stub.fetch(test.url("/command", false), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body });
    expect(publicAttempt.status).toBe(401); await publicAttempt.text();
    const accepted = await test.stub.fetch(rundownInternalRequest(test.url("/command", false), env.BETTER_AUTH_SECRET, { method: "POST", body }));
    expect(accepted.status).toBe(200); await accepted.text();
    const state = await test.stub.fetch(rundownInternalRequest(test.url("/state", false), env.BETTER_AUTH_SECRET));
    expect(await state.json()).toMatchObject({ ppPreviewSlide: null, stageMessage: "Automation" });
    expect(() => rundownInternalRequest(test.url("/command"), undefined)).toThrow("not configured");
  });

  it.each(["missing", "expired", "revoked", "wrong-user"])("rejects HTTP commands with a %s claim", async kind => {
    const test = await fixture();
    const url = test.url("/command", kind !== "missing");
    if (kind === "expired") await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(test.authority.sessionId).run();
    if (kind === "revoked") await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    if (kind === "wrong-user") url.searchParams.set("authUserId", "someone-else");
    const response = await test.command(url);
    expect(response.status).toBe(401);
    await response.text();
  });

  it("does not let a claimless write request relabel and empty a live room", async () => {
    const test = await fixture();
    expect(await (await test.command(test.url("/command"))).json()).toMatchObject({ ok: true });
    const original = await (await test.stub.fetch(test.url("/state"))).json<{ serviceDate: string; revision: number; stageMessage: string }>();
    const forged = test.url("/command", false);
    forged.searchParams.set("serviceDate", "2026-12-01");
    const rejected = await test.command(forged);
    expect(rejected.status).toBe(401);
    await rejected.text();
    const read = test.url("/state"); read.searchParams.set("access", "observe");
    expect(await (await test.stub.fetch(read)).json()).toMatchObject({ serviceDate: original.serviceDate, revision: original.revision, stageMessage: original.stageMessage });
  });

  it.each(["control", "edit", "observe"])("projects a claimless %s read as display-only", async access => {
    const test = await fixture();
    const url = test.url("/state", false); url.searchParams.set("access", access);
    expect(await (await test.stub.fetch(url)).json()).not.toHaveProperty("ppPreviewSlide");
    url.pathname = "/ws";
    const response = await test.stub.fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing display socket");
    const hydrate = new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
    socket.accept();
    expect(await hydrate).not.toHaveProperty("state.ppPreviewSlide");
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "command", action: "stage-clear" }));
    expect(await closed).toMatchObject({ code: 4403 });
  });

  it("rejects a revoked operator after hibernation", async () => {
    const test = await fixture();
    const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing operator socket");
    const hydrate = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
    socket.accept(); await hydrate;
    await evictDurableObject(test.stub);
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "command", action: "stage-clear" }));
    expect(await closed).toMatchObject({ code: 4403 });
  });
});
