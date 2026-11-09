import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";

afterEach(() => abortAllDurableObjects());
async function fixture(access: "control" | "observe" | "display" = "observe") {
  const actor = await seedRelayMember(crypto.randomUUID());
  const showId = crypto.randomUUID(), serviceDate = "2026-11-08";
  await getPrisma().rundown.create({ data: { id: showId, orgId: actor.orgId, serviceDate, name: "Heartbeat fixture" } });
  const stub = env.RUNDOWN_RELAY.getByName(`${actor.orgId}:show:${showId}`);
  const query = new URLSearchParams({orgId:actor.orgId, showId, serviceDate});
  // Readers must not initialize/relabel a room. Prepare it through a real
  // operator read before testing read-only liveness and stable revisions.
  const preparation = new URLSearchParams({...Object.fromEntries(query), access:"control", authUserId:actor.userId, authSessionId:actor.sessionId});
  const prepared = await stub.fetch(`https://rundown.test/state?${preparation}`);
  expect(prepared.status).toBe(200);
  await prepared.arrayBuffer();
  if(access !== "display") {
    query.set("access",access);
    query.set("authUserId",actor.userId);
    query.set("authSessionId",actor.sessionId);
  }
  const response = await stub.fetch(`https://rundown.test/ws?${query}`, {headers:{Upgrade:"websocket"}});
  expect(response.status).toBe(101);
  const socket=response.webSocket;
  if(!socket) throw new Error("Missing heartbeat socket");
  const hydration = new Promise<{state:{revision:number}}>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), {once:true}));
  socket.accept();
  const initial = await hydration;
  return {stub,socket,showId,serviceDate,revision:initial.state.revision};
}
function nextMessage(socket: WebSocket) {
  return new Promise<unknown>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), {once:true}));
}
it.each(["control", "observe", "display"] as const)("acknowledges a bounded %s heartbeat without changing state, including after eviction", async access => {
  const f=await fixture(access);
  for(const id of ["hb-before", "hb-after"]) {
    if(id === "hb-after") await evictDurableObject(f.stub);
    const reply=nextMessage(f.socket);
    f.socket.send(JSON.stringify({type:"ping",id}));
    expect(await reply).toEqual({type:"pong",id,showId:f.showId,serviceDate:f.serviceDate,revision:f.revision});
  }
  f.socket.close();
});
it("ignores legacy pings and invalid ids without echoing their payload", async () => {
  const f=await fixture();
  for(const id of [undefined, "x".repeat(129), {secret:"not-an-id"}, "<html>"]) f.socket.send(JSON.stringify({type:"ping",id,payload:"private"}));
  const reply=nextMessage(f.socket);
  f.socket.send(JSON.stringify({type:"ping",id:"valid-id"}));
  expect(await reply).toEqual({type:"pong",id:"valid-id",showId:f.showId,serviceDate:f.serviceDate,revision:f.revision});
  f.socket.close();
});
it.each(["member", "display"] as const)("does not acknowledge an expired %s read lease", async kind => {
  const f=await fixture(kind === "display" ? "display" : "observe");
  await runInDurableObject(f.stub, async (_instance,ctx) => {
    const socket=ctx.getWebSockets()[0];
    const attachment:unknown=socket.deserializeAttachment();
    if(!attachment || typeof attachment !== "object") throw new Error("Missing read attachment");
    socket.serializeAttachment({...attachment,[kind === "display" ? "displayExpiresAt" : "readAuthorizedUntil"]:Date.now()-1});
  });
  const messages:unknown[]=[];
  f.socket.addEventListener("message",event=>messages.push(JSON.parse(String(event.data))));
  const closed=new Promise<CloseEvent>(resolve=>f.socket.addEventListener("close",resolve,{once:true}));
  f.socket.send(JSON.stringify({type:"ping",id:"expired-lease"}));
  expect(await closed).toMatchObject({code:4403});
  expect(messages).toEqual([]);
});
