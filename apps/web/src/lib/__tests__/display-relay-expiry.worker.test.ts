import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => { await abortAllDurableObjects(); });
function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}

describe("display socket expiry", () => {
  it.each(["timecode", "rundown", "lowerthirds"])("stops %s broadcasts after the pass deadline, including after hibernation", async (kind) => {
    const orgId = `display-expiry-${kind}`;
    await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Display expiry fixture', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
    const clock = kind === "timecode" ? await timecodeFixture(orgId) : null;
    const stub = clock ? clock.stub
      : kind === "rundown" ? env.RUNDOWN_RELAY.getByName(orgId)
      : env.LOWER_THIRDS_RELAY.getByName(orgId);
    const query = new URLSearchParams({ orgId, access: "read", serviceDate: "2026-11-04", authDisplayExpiresAt: String(Date.now() + 60_000) });
    if (clock) query.set("showId", clock.target.showId);
    const response = await stub.fetch(new Request(`https://relay.test/ws?${query}`, { headers: { Upgrade: "websocket" } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing display socket");
    const hydrated = kind === "lowerthirds" ? null : nextMessage(socket);
    socket.accept();
    if (hydrated) {
      const first = await hydrated;
      expect(first.type).toBe("hydrate");
      if (kind === "timecode") expect(first).not.toHaveProperty("events");
    }
    const received: unknown[] = [];
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
    await runInDurableObject(stub, async (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment: unknown = ws.deserializeAttachment();
        if (!attachment || typeof attachment !== "object") throw new Error("Missing socket attachment");
        ws.serializeAttachment({ ...attachment, displayExpiresAt: Date.now() - 1 });
      }
    });
    await evictDurableObject(stub);
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    const body = kind === "timecode"
      ? { action: "set-lyrics", payload: { songId: "fixture", songTitle: "Fixture", sectionId: "verse", sectionLabel: "Verse", lyrics: "Protected lyric" } }
      : kind === "rundown" ? { action: "stage-message", payload: { message: "Protected stage message" } }
      : { line1: "Protected lower third" };
    query.set("access", kind === "rundown" ? "control" : "write"); query.delete("authDisplayExpiresAt");
    const authority = clock?.authority ?? await seedRelayMember(orgId);
    if (kind !== "rundown") {
      query.set("authUserId", authority.userId);
      query.set("authSessionId", authority.sessionId);
    }
    const command = await stub.fetch(new Request(`https://relay.test/${kind === "lowerthirds" ? "trigger" : "command"}?${query}`, { method: "POST", body: JSON.stringify(body) }));
    expect(command.status).toBe(200); await command.arrayBuffer();
    await expect(closed).resolves.toMatchObject({ code: 4403, reason: "Display pass expired" });
    expect(received).toEqual([]);
  });
});
