import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const orgId = `chat-authority-${crypto.randomUUID()}`;
  const authority = await seedRelayMember(orgId);
  const stub = env.CHAT_RELAY.getByName(`${orgId}:production`);
  const url = (path: string, claimed = true) => {
    const url = new URL(`https://chat.test${path}`);
    url.search = new URLSearchParams({ orgId, room: "production", access: "write", userId: authority.userId, name: "Operator", role: "owner" }).toString();
    if (claimed) {
      url.searchParams.set("authUserId", authority.userId);
      url.searchParams.set("authSessionId", authority.sessionId);
    }
    return url;
  };
  return { orgId, authority, stub, url };
}

describe("ChatRelay live authority", () => {
  it("does not treat an external access flag as import authority", async () => {
    const test = await fixture();
    for (const path of ["/external/import", "/internal/external-import"]) {
      const url = test.url(path, false);
      url.searchParams.set("access", "external");
      const response = await test.stub.fetch(url, {
        method: "POST", body: JSON.stringify({ platform: "slack", message: { externalId: "forged", senderName: "Forged", text: "Rejected", timestamp: Date.now() } }),
      });
      expect(response.status).toBe(path.startsWith("/internal/") ? 401 : 404);
      await response.text();
    }
    expect(await (await test.stub.fetch(test.url("/history"))).json()).toMatchObject({ messages: [] });
  });

  it.each(["missing", "expired", "revoked", "wrong-user"])("rejects HTTP messages with a %s claim", async kind => {
    const test = await fixture();
    const url = test.url("/send", kind !== "missing");
    if (kind === "expired") await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(test.authority.sessionId).run();
    if (kind === "revoked") await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    if (kind === "wrong-user") url.searchParams.set("authUserId", "someone-else");
    const response = await test.stub.fetch(url, { method: "POST", body: '{"text":"Rejected"}' });
    expect(response.status).toBe(401);
    await response.text();
  });

  it.each(["missing", "legacy-integration", "revoked"])("rejects %s socket writes after hibernation", async kind => {
    const test = await fixture();
    const url = test.url("/ws", kind === "revoked");
    if (kind === "legacy-integration") url.searchParams.delete("userId");
    const response = await test.stub.fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing chat socket");
    const hydrated = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
    socket.accept(); await hydrated;
    if (kind === "revoked") await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    await evictDurableObject(test.stub);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "message", text: "Rejected" }));
    expect(await closed).toMatchObject({ code: 4403 });
    expect(await (await test.stub.fetch(test.url("/history"))).json()).toMatchObject({ messages: [] });
  });

  it("uses the authenticated member for HTTP attribution", async () => {
    const test = await fixture();
    const response = await test.stub.fetch(test.url("/send"), { method: "POST", body: JSON.stringify({ text: "Accepted", senderId: "forged", senderName: "Forged", senderRole: "Forged" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: { senderId: test.authority.userId, senderName: "Operator", senderRole: "owner" } });
  });

  it("requires Worker attestation for guest upgrades", async () => {
    const test = await fixture();
    for (const path of ["/ws", "/internal/guest-ws"]) {
      const url = test.url(path, false);
      url.searchParams.set("role", "Guest");
      url.searchParams.set("guestExpiresAt", String(Date.now() + 60000));
      const response = await test.stub.fetch(url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": "forged" } });
      expect(response.status).toBe(401);
      await response.text();
    }
  });
});
