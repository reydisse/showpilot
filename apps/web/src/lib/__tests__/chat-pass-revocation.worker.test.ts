import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { signToken } from "../kiosk-token";
import { chatPassDigest, recordChatPassRevocation } from "../chat-pass-revocation.server";
import { verifyCrewChatPass } from "../chat-pass-revocation.server";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const orgId = crypto.randomUUID();
  const actor = await seedRelayMember(orgId);
  const expiresAt = (Math.floor(Date.now()/1000)+3600)*1000;
  const token = `chat_${await signToken({ orgId, orgSlug: orgId, scope: "crew-chat", exp: expiresAt/1000 }, env.KIOSK_SECRET)}`;
  const tokenHash = await chatPassDigest(token);
  const stub = env.CHAT_RELAY.getByName(`${orgId}:production`);
  const url = new URL("https://chat.test/internal/guest-ws");
  url.search = new URLSearchParams({ orgId, room: "production", name: "Guest", guestExpiresAt: String(expiresAt), guestTokenHash: tokenHash }).toString();
  const open = async () => {
    const response = await stub.fetch(url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
    expect(response.status).toBe(101);
    const socket = response.webSocket; if (!socket) throw new Error("Missing guest socket");
    const hydrated = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
    socket.accept(); await hydrated;
    return socket;
  };
  const revoke = () => recordChatPassRevocation(env.DB, { orgId, token, scope: "crew-chat", expiresAt, actorId: actor.userId });
  return { orgId, actor, expiresAt, token, tokenHash, stub, url, open, revoke };
}
it.each(["push", "alarm", "write"])("cuts off a revoked guest through %s after hibernation", async mode => {
  const f = await fixture(); const socket = await f.open();
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
  await f.revoke(); await evictDurableObject(f.stub);
  if (mode === "push") await f.stub.refreshReadAuthority();
  else if (mode === "alarm") await runDurableObjectAlarm(f.stub);
  else socket.send(JSON.stringify({ type: "message", text: "Must not persist" }));
  expect(await closed).toMatchObject({ code: 4403, reason: "Guest pass revoked" });
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    expect(ctx.storage.sql.exec("SELECT id FROM chat_messages").toArray()).toHaveLength(0);
  });
  expect(await verifyCrewChatPass(f.token, env.KIOSK_SECRET, env.DB)).toBeNull();
  const denied = await f.stub.fetch(f.url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
  expect(denied.status).toBe(401); await denied.text();
});
it("closes guests at a stale read lease even if revocation push and alarm did not run", async () => {
  const f = await fixture(); const socket = await f.open();
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    for (const peer of ctx.getWebSockets()) peer.serializeAttachment({ ...peer.deserializeAttachment(), readAuthorizedUntil: Date.now()-1 });
  });
  await evictDurableObject(f.stub);
  socket.send(JSON.stringify({ type: "typing", typing: true }));
  expect(await closed).toMatchObject({ code: 4403, reason: "Read authorization expired. Reconnect." });
});
it.each(["push", "delayed alarm"])("retains another guest pass when one link is disabled through %s", async mode => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const f = await fixture(); const first = await f.open();
    const otherToken = `chat_${await signToken({ orgId: f.orgId, orgSlug: f.orgId, scope: "crew-chat", exp: f.expiresAt/1000, iat: 1 }, env.KIOSK_SECRET)}`;
    f.url.searchParams.set("guestTokenHash", await chatPassDigest(otherToken));
    const other = await f.open();
    const closed = new Promise<CloseEvent>(resolve => first.addEventListener("close", resolve, { once: true }));
    await f.revoke();
    if (mode === "delayed alarm") {
      await evictDurableObject(f.stub);
      clock.mockReturnValue(now + 60_001);
      await runDurableObjectAlarm(f.stub);
    } else {
      await f.stub.refreshReadAuthority();
    }
    expect(await closed).toMatchObject({ code: 4403, reason: "Guest pass revoked" });
    expect(other.readyState).toBe(WebSocket.OPEN);
    const sent = new Promise<MessageEvent>(resolve => other.addEventListener("message", resolve, { once: true }));
    other.send(JSON.stringify({ type: "message", text: "Other pass remains valid" }));
    expect(JSON.parse((await sent).data)).toMatchObject({ type: "message", message: { text: "Other pass remains valid" } });
    other.close();
  } finally {
    clock.mockRestore();
  }
});
