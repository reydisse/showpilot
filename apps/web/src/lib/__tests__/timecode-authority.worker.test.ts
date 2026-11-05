import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";

afterEach(() => abortAllDurableObjects());
const cue = { id: "private-cue", action: "stage-message", label: "Operator cue", payload: { message: "Private payload" }, triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } };
function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
}

describe("TimecodeRelay live session authority", () => {
  it("projects a claimless write socket as a display and rejects its mutation", async () => {
    const fixture = await timecodeFixture();
    const url = fixture.url("/ws");
    url.searchParams.delete("authSessionId");
    const response = await fixture.stub.fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing display socket");
    const hydrated = nextFrame(socket);
    socket.accept();
    expect(await hydrated).not.toHaveProperty("events");
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "command", action: "add-event", payload: cue }));
    expect(await closed).toMatchObject({ code: 4403 });
    expect(await (await fixture.stub.fetch(fixture.url("/events"))).json()).toEqual([]);
  });

  it.each(["missing", "expired", "wrong-user"])("rejects HTTP writes with a %s session and hides operator events", async kind => {
    const fixture = await timecodeFixture();
    const url = fixture.url("/command");
    if (kind === "missing") url.searchParams.delete("authSessionId");
    if (kind === "wrong-user") url.searchParams.set("authUserId", "another-user");
    if (kind === "expired") await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?").bind(fixture.authority.sessionId).run();
    const response = await fixture.stub.fetch(url, { method: "POST", body: JSON.stringify({ action: "add-event", payload: cue }) });
    expect(response.status).toBe(401);
    url.pathname = "/events";
    expect((await fixture.stub.fetch(url)).status).toBe(401);
    url.pathname = "/state";
    expect(await (await fixture.stub.fetch(url)).json()).not.toHaveProperty("source");
  });

  it("revalidates a member's socket after revocation and hibernation", async () => {
    const fixture = await timecodeFixture();
    const response = await fixture.stub.fetch(fixture.url("/ws"), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing operator socket");
    const hydrated = nextFrame(socket);
    socket.accept();
    expect(await hydrated).toHaveProperty("events", []);
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(fixture.orgId, fixture.authority.userId).run();
    await evictDurableObject(fixture.stub);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "command", action: "add-event", payload: cue }));
    expect(await closed).toMatchObject({ code: 4403 });
    await runInDurableObject(fixture.stub, async (_instance, ctx) => {
      expect(await ctx.storage.get("timecode")).toMatchObject({ events: [] });
    });
  });
});
