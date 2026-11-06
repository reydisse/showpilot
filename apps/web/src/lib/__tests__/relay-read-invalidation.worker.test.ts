import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import { refreshOrgReadAuthority, refreshUserReadAuthority } from "../relay-read-invalidation.server";

afterEach(() => abortAllDurableObjects());

it.each(["membership", "session"])("pushes %s revocation to every org room without closing another user's reads", async change => {
  const first = await timecodeFixture();
  const second = await timecodeFixture(first.orgId, `${first.orgId}-second-show`);
  const member = first.authority;
  const survivor = await seedRelayMember(first.orgId, `${first.orgId}-survivor`);
  const dm = `dm:${member.userId}:${survivor.userId}`;
  await env.DB.prepare("INSERT INTO chat_user_room (userId,orgId,roomId) VALUES (?,?,?)").bind(member.userId, first.orgId, dm).run();
  const targets = [
    { stub: first.stub, url: first.url("/ws") },
    { stub: second.stub, url: second.url("/ws") },
    ...[first, second].map(show => ({ stub: env.RUNDOWN_RELAY.getByName(`${first.orgId}:show:${show.target.showId}`), url: show.url("/ws", "observe") })),
    { stub: env.BRIDGE_RELAY.getByName(first.orgId), url: new URL("https://relay.test/ws") },
    { stub: env.LOWER_THIRDS_RELAY.getByName(first.orgId), url: new URL("https://relay.test/ws") },
    { stub: env.CUE_SHEET_RELAY.getByName(first.orgId), url: new URL("https://relay.test/ws") },
    ...["production", "planning", dm].map(room => ({ stub: env.CHAT_RELAY.getByName(`${first.orgId}:${room}`), url: new URL(`https://relay.test/ws?room=${room}`) })),
  ];
  const closed = new Map<number, number>();
  const survivors: WebSocket[] = [];
  for (const target of targets) {
    for (const identity of [member, survivor]) {
      const url = new URL(target.url);
      for (const [key, value] of Object.entries({ orgId: first.orgId, authUserId: identity.userId, userId: identity.userId, authSessionId: identity.sessionId, role: "client", access: url.searchParams.get("access") ?? "write" })) url.searchParams.set(key, value);
      const response = await target.stub.fetch(url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
      const socket = response.webSocket;
      if (!socket) throw new Error(`Missing socket: ${url.pathname} (${response.status})`);
      socket.accept();
      if (identity === member) socket.addEventListener("close", event => { closed.set(targets.indexOf(target), event.code); }, { once: true });
      else survivors.push(socket);
    }
  }
  if (change === "membership") {
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(first.orgId, member.userId).run();
    await refreshOrgReadAuthority(first.orgId, member.userId);
  } else {
    await env.DB.prepare("DELETE FROM session WHERE id=?").bind(member.sessionId).run();
    await refreshUserReadAuthority(member.userId);
  }
  await vi.waitFor(() => expect([...closed.entries()].sort()).toEqual(targets.map((_, index) => [index, 4403])), { timeout: 2000 });
  for (const socket of survivors) { expect(socket.readyState).toBe(WebSocket.OPEN); socket.close(); }
});
