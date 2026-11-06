import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";

afterEach(() => abortAllDurableObjects());

async function graphics() {
  const orgId = `graphics-${crypto.randomUUID()}`;
  const authority = await seedRelayMember(orgId);
  const stub = env.LOWER_THIRDS_RELAY.getByName(orgId);
  const url = (path: string, claimed = true) => {
    const url = new URL(`https://graphics.test${path}`);
    url.searchParams.set("orgId", orgId);
    url.searchParams.set("access", "write");
    if (claimed) {
      url.searchParams.set("authUserId", authority.userId);
      url.searchParams.set("authSessionId", authority.sessionId);
    }
    return url;
  };
  const post = (path: string, claimed = true, headers?: HeadersInit) => stub.fetch(url(path, claimed), {
    method: "POST", headers, body: JSON.stringify({ line1: "Fixture graphic" }),
  });
  return { orgId, authority, stub, url, post };
}

describe("lower-third authority", () => {
  it("rejects a live member session without graphics permission", async () => {
    const fixture = await graphics();
    await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(fixture.orgId, fixture.authority.userId).run();
    const response = await fixture.post("/trigger");
    expect(response.status).toBe(401);
    await response.text();
  });

  it("publishes an authorized socket trigger after hibernation", async () => {
    const fixture = await graphics();
    const response = await fixture.stub.fetch(fixture.url("/ws"), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing graphics operator");
    socket.accept();
    await evictDurableObject(fixture.stub);
    const received = new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
    socket.send(JSON.stringify({ action: "trigger", payload: { line1: "Authorized" } }));
    expect(await received).toMatchObject({ action: "show", payload: { line1: "Authorized" } });
    expect(await (await fixture.stub.fetch(fixture.url("/current", false))).json()).toMatchObject({ current: { line1: "Authorized" }, queue: null });
    socket.close();
  });

  it.each(["/trigger", "/clear", "/queue"])("rejects claimless %s even with a write flag or internal header", async path => {
    const fixture = await graphics();
    for (const headers of [undefined, { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }]) {
      const response = await fixture.post(path, false, headers);
      expect(response.status).toBe(401);
      await response.text();
    }
    expect(await (await fixture.stub.fetch(fixture.url("/current"))).json()).toEqual({ current: null, queue: null });
  });

  it("hides the queued graphic from a display while preserving live output", async () => {
    const fixture = await graphics();
    expect(await (await fixture.post("/trigger")).json()).toMatchObject({ ok: true });
    expect(await (await fixture.post("/queue")).json()).toMatchObject({ ok: true });
    expect(await (await fixture.stub.fetch(fixture.url("/current"))).json()).toMatchObject({ queue: { line1: "Fixture graphic" } });
    expect(await (await fixture.stub.fetch(fixture.url("/current", false))).json()).toMatchObject({ current: { line1: "Fixture graphic" }, queue: null });
  });

  it.each(["expired", "revoked", "wrong-user"])("rejects %s session claims", async kind => {
    const fixture = await graphics();
    if (kind === "expired") await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(fixture.authority.sessionId).run();
    if (kind === "revoked") await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(fixture.orgId, fixture.authority.userId).run();
    const url = fixture.url("/trigger");
    if (kind === "wrong-user") url.searchParams.set("authUserId", "another-user");
    const response = await fixture.stub.fetch(url, { method: "POST", body: '{"line1":"Rejected"}' });
    expect(response.status).toBe(401);
    await response.text();
  });

  it.each([false, true])("rejects socket writes after hibernation with revoked=%s", async revoked => {
    const fixture = await graphics();
    const response = await fixture.stub.fetch(fixture.url("/ws", revoked), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing graphics socket");
    socket.accept();
    if (revoked) await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(fixture.orgId, fixture.authority.userId).run();
    await evictDurableObject(fixture.stub);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ action: "trigger", payload: { line1: "Rejected" } }));
    expect(await closed).toMatchObject({ code: 4403 });
    expect(await (await fixture.stub.fetch(fixture.url("/current", false))).json()).toMatchObject({ current: null });
  });

  it("accepts automation only through the explicit secret-protected internal paths", async () => {
    const fixture = await graphics();
    for (const path of ["/internal/trigger", "/internal/clear"]) {
      for (const secret of ["", "wrong"]) {
        const rejected = await fixture.post(path, false, { "x-showpilot-internal-secret": secret });
        expect(rejected.status).toBe(401);
        await rejected.text();
      }
      const accepted = await fixture.post(path, false, { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET });
      expect(accepted.status).toBe(200);
      await accepted.text();
      expect(await (await fixture.stub.fetch(fixture.url("/current", false))).json()).toMatchObject({
        current: path.endsWith("trigger") ? { line1: "Fixture graphic" } : null,
      });
    }
  });
});
