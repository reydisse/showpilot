import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";

afterEach(() => abortAllDurableObjects());
const note = { type: "note", serviceDate: "2026-11-05", itemId: "item", columnId: "column", text: "Fixture note", by: "Fixture", at: 1 };
async function fixture() {
  const orgId = `cue-sheet-${crypto.randomUUID()}`;
  const authority = await seedRelayMember(orgId);
  const stub = env.CUE_SHEET_RELAY.getByName(orgId);
  const url = (path: string, claimed = true) => {
    const url = new URL(`https://cue-sheet.test${path}`);
    url.searchParams.set("orgId", orgId);
    url.searchParams.set("access", "columns,notes,incidents");
    if (claimed) {
      url.searchParams.set("authUserId", authority.userId);
      url.searchParams.set("authSessionId", authority.sessionId);
    }
    return url;
  };
  return { orgId, authority, stub, url };
}

describe("cue-sheet authority", () => {
  it("checks each event permission even when the URL requests every scope", async () => {
    const test = await fixture();
    await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    for (const event of [note, { type: "columns", at: 1 }]) {
      const response = await test.stub.fetch(test.url("/broadcast"), { method: "POST", body: JSON.stringify(event) });
      expect(response.status).toBe(event.type === "note" ? 200 : 401);
      await response.text();
    }
  });

  it.each(["missing", "expired", "revoked", "wrong-user"])("rejects HTTP broadcasts with a %s claim", async kind => {
    const test = await fixture();
    const url = test.url("/broadcast", kind !== "missing");
    if (kind === "expired") await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(test.authority.sessionId).run();
    if (kind === "revoked") await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    if (kind === "wrong-user") url.searchParams.set("authUserId", "another-user");
    const response = await test.stub.fetch(url, { method: "POST", body: JSON.stringify(note) });
    expect(response.status).toBe(401);
    await response.text();
  });

  it.each([false, true])("rejects socket broadcasts after hibernation with revoked=%s", async revoked => {
    const test = await fixture();
    const response = await test.stub.fetch(test.url("/ws", revoked), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing cue-sheet socket");
    socket.accept();
    if (revoked) await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    await evictDurableObject(test.stub);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify(note));
    expect(await closed).toMatchObject({ code: 4403 });
  });

  it("delivers authorized notes to read-only listeners after hibernation", async () => {
    const test = await fixture();
    const response = await test.stub.fetch(test.url("/ws", false), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing cue-sheet listener");
    socket.accept();
    await evictDurableObject(test.stub);
    const received = new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
    const published = await test.stub.fetch(test.url("/broadcast"), { method: "POST", body: JSON.stringify(note) });
    expect(published.status).toBe(200);
    await published.text();
    expect(await received).toEqual(note);
    socket.close();
  });
});
