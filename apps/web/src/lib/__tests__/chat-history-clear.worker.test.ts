import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { clearChatHistory } from "../chat";
import { clearOrganizationChat, type ChatClearDatabase } from "../chat-history-clear.server";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}

afterEach(async () => { await abortAllDurableObjects(); });
async function send(roomId: string, text: string) {
  const {orgId, actor} = authenticated;
  const stub = env.CHAT_RELAY.getByName(`${orgId}:${roomId}`);
  const params = new URLSearchParams({orgId,room:roomId,access:"write",userId:actor.userId,authUserId:actor.userId,authSessionId:actor.sessionId});
  const response = await stub.fetch(new Request(`https://chat.test/send?${params}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})}));
  expect(response.status).toBe(200);
  return (await response.json<{message:{id:string}}>()).message.id;
}
async function history(roomId: string) {
  const {orgId} = authenticated;
  const response = await env.CHAT_RELAY.getByName(`${orgId}:${roomId}`).fetch(`https://chat.test/history?${new URLSearchParams({orgId,room:roomId})}`);
  return (await response.json<{messages:Array<{id:string;text:string}>}>()).messages;
}
function command() { return {orgId:authenticated.orgId,confirmName:authenticated.orgId,requestId:crypto.randomUUID()}; }
it("clears actual native room history rather than only the legacy database table", async () => {
  await send("production","Before clear");
  expect(await history("production")).toHaveLength(1);
  await clearChatHistory({data:command()});
  expect(await history("production")).toEqual([]);
});

const authority = () => ({...authenticated.actor,orgId:authenticated.orgId});
const roomClear = (input: Parameters<NonNullable<Parameters<typeof clearOrganizationChat>[0]["clearRoom"]>>[0]) => env.CHAT_RELAY.getByName(`${input.orgId}:${input.roomId}`).clearHistory(input);
async function legacy(text:string,orgId=authenticated.orgId) {
  return env.DB.prepare("INSERT INTO chat_message(id,orgId,message,senderName,createdAt) VALUES(?,?,?,?,CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),orgId,text,"Member").run();
}

it("clears indexed direct rooms, Planning, Production and legacy rows with org isolation",async()=>{
  const {orgId,userId}=authenticated;
  const room=`dm:${[userId,"peer"].sort().join(":")}`;
  await env.DB.prepare("INSERT INTO chat_user_room(userId,orgId,roomId,updatedAt) VALUES(?,?,?,?)").bind(userId,orgId,room,Date.now()).run();
  await send(room,"Private history");await send("planning","Plans");await send("production","Show");await legacy("Old database message");
  const foreign=await seedRelayMember("foreign-clear-org");
  await legacy("Keep",foreign.orgId);
  const result=await clearChatHistory({data:command()});
  expect(result.rooms).toHaveLength(3);expect(result.rooms.every(r=>r.cleared)).toBe(true);
  for(const r of result.rooms)expect(await history(r.roomId)).toEqual([]);
  expect(await getPrisma().chatMessage.count({where:{orgId}})).toBe(0);
  expect(await getPrisma().chatMessage.count({where:{orgId:foreign.orgId}})).toBe(1);
});
it("keeps later messages when a lost reply is retried, including after relay eviction",async()=>{
  const input=command();await send("production","Before");await legacy("Before");
  const first=await clearChatHistory({data:input});
  await send("production","After");await legacy("After");
  await evictDurableObject(env.CHAT_RELAY.getByName(`${input.orgId}:production`));
  const replay=await clearChatHistory({data:input});
  expect(replay).toEqual(first);expect((await history("production")).map(m=>m.text)).toEqual(["After"]);
  expect((await env.DB.prepare("SELECT message FROM chat_message WHERE orgId=?").bind(input.orgId).all<{message:string}>()).results.map(m=>m.message)).toEqual(["After"]);
});
it("reports partial failure and finishes the original cutoff without clearing new messages",async()=>{
  const input=command();await send("production","Old production");await send("planning","Old planning");
  const result=await clearOrganizationChat({command:input,authority:authority(),clearRoom:async command=>{
    if(command.roomId==="planning")throw new Error("Room unavailable");return roomClear(command);
  }});
  expect(result.rooms).toEqual([{roomId:"planning",cleared:false},{roomId:"production",cleared:true}]);
  await new Promise(resolve=>setTimeout(resolve,2));
  await send("production","New production");await send("planning","New planning");
  const retried=await clearChatHistory({data:input});expect(retried.rooms.every(r=>r.cleared)).toBe(true);
  expect((await history("production")).map(m=>m.text)).toEqual(["New production"]);
  expect((await history("planning")).map(m=>m.text)).toEqual(["New planning"]);
});
it("commits concurrent duplicates once and rejects a different confirmation on the same ID",async()=>{
  const input=command();await send("production","Before");
  const values=await Promise.all([clearChatHistory({data:input}),clearChatHistory({data:input})]);
  expect(values[0]).toEqual(values[1]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_history_clear_receipt WHERE orgId=?").bind(input.orgId).first()).toEqual({count:1});
  await expect(clearChatHistory({data:{...input,confirmName:"Different"}})).rejects.toThrow("different confirmation");
});
it("requires exact confirmation, authenticated session and current Danger Zone permission",async()=>{
  const input=command();await send("production","Keep");
  await expect(clearChatHistory({data:{...input,confirmName:"wrong"}})).rejects.toThrow("exact name");
  await expect(clearChatHistory({data:{...input,orgId:"foreign"}})).rejects.toThrow("permission");
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=?").bind(input.orgId).run();
  await expect(clearChatHistory({data:input})).rejects.toThrow("permission");
  auth.cookie="";await expect(clearChatHistory({data:input})).rejects.toThrow("Sign in");
  expect((await history("production")).map(m=>m.text)).toEqual(["Keep"]);
});
it("revoked sessions cannot replay a previously accepted clear",async()=>{
  const input=command();await clearChatHistory({data:input});await send("production","Keep");
  await env.DB.prepare("DELETE FROM session WHERE id=?").bind(authenticated.actor.sessionId).run();
  await expect(clearChatHistory({data:input})).rejects.toThrow("Sign in");
  expect((await history("production")).map(m=>m.text)).toEqual(["Keep"]);
});
it("rolls back the receipt and legacy delete together and recovers with the same request",async()=>{
  const input=command();await legacy("Keep until retry");await send("production","Keep until retry");
  await env.DB.exec("CREATE TRIGGER fail_chat_clear BEFORE DELETE ON chat_message BEGIN SELECT RAISE(ABORT,'fixture clear failure'); END;");
  await expect(clearChatHistory({data:input})).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_history_clear_receipt WHERE orgId=?").bind(input.orgId).first()).toEqual({count:0});
  expect(await history("production")).toHaveLength(1);
  await env.DB.exec("DROP TRIGGER fail_chat_clear");
  expect((await clearChatHistory({data:input})).rooms.every(r=>r.cleared)).toBe(true);
});
it("checks membership again when committing the destructive receipt",async()=>{
  const input=command();await legacy("Keep");
  const database:ChatClearDatabase={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(input.orgId,authenticated.userId).run();
    return env.DB.batch(statements);
  }};
  await expect(clearOrganizationChat({command:input,authority:authority(),database})).rejects.toThrow("access or organization changed");
  expect(await getPrisma().chatMessage.count({where:{orgId:input.orgId}})).toBe(1);
});
it("requires the receipt, room scope and live authority at the relay too",async()=>{
  const input=command();
  const stub=env.CHAT_RELAY.getByName(`${input.orgId}:production`);
  const delivery={...input,roomId:"production",authority:authority(),deadline:Date.now()+7000};
  expect(await stub.clearHistory(delivery)).toMatchObject({cleared:false,error:expect.stringContaining("receipt is missing")});
  await clearChatHistory({data:input});
  expect(await stub.clearHistory({...delivery,roomId:"unknown"})).toMatchObject({cleared:false,error:expect.stringContaining("does not include")});
  expect(await stub.clearHistory({...delivery,deadline:Date.now()-1})).toMatchObject({cleared:false,error:expect.stringContaining("expired")});
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=?").bind(input.orgId).run();
  expect(await stub.clearHistory(delivery)).toMatchObject({cleared:false,error:expect.stringContaining("access changed")});
});
it("keeps history beyond the hydration window cleared and blocks old external imports",async()=>{
  const input=command();const stub=env.CHAT_RELAY.getByName(`${input.orgId}:production`);
  await send("production","Recent");
  await runInDurableObject(stub,async(_instance,state)=>{
    state.storage.transactionSync(()=>{
      for(let i=0;i<2100;i++)state.storage.sql.exec("INSERT INTO chat_messages(id,timestamp,payload) VALUES(?,?,?)",`older-${i}`,1,JSON.stringify({id:`older-${i}`,timestamp:1,orgId:input.orgId,senderName:"Member",text:"Old",type:"text"}));
    });
  });
  const cleared=await clearChatHistory({data:input});
  const response=await stub.fetch(new Request(`https://chat.test/internal/external-import?orgId=${input.orgId}`,{method:"POST",headers:{"Content-Type":"application/json","x-showpilot-internal-secret":"worker-test-secret-for-local-integration-only"},body:JSON.stringify({platform:"slack",message:{externalId:"old-external",senderName:"External",text:"Old",timestamp:cleared.cutoff}})}));
  expect(response.status).toBe(200);expect(await history("production")).toEqual([]);
  await runInDurableObject(stub,async(_instance,state)=>expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM chat_messages").toArray()).toEqual([{count:0}]));
});

it("notifies live clients and rejects re-sending an already cleared message ID",async()=>{
  const input=command();const actor=authority();
  const stub=env.CHAT_RELAY.getByName(`${input.orgId}:production`);
  const oldId=await send("production","Erase this");
  const response=await stub.fetch(new Request(`https://chat.test/ws?${new URLSearchParams({orgId:input.orgId,access:"write",userId:actor.userId,authUserId:actor.userId,authSessionId:actor.sessionId})}`,{headers:{Upgrade:"websocket"}}));
  if(!response.webSocket)throw new Error("Fixture socket missing");
  const socket=response.webSocket;
  const next=(type:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.removeEventListener("message",listen);reject(new Error(`Missing ${type} frame`));},2000);
    function listen(event:MessageEvent){const value=JSON.parse(String(event.data));if(value.type===type){clearTimeout(timer);socket.removeEventListener("message",listen);resolve(value);}}
    socket.addEventListener("message",listen);
  });
  const hydration=next("hydrate");socket.accept();await hydration;
  const cleared=next("hydrate");await clearChatHistory({data:input});
  expect(await cleared).toMatchObject({historyCleared:true,historyClearVersion:1,messages:[]});
  const rejected=next("error");socket.send(JSON.stringify({type:"message",clientMessageId:oldId,text:"Resurrect"}));
  expect(await rejected).toMatchObject({messageId:oldId,error:expect.stringContaining("already cleared")});
  expect(await history("production")).toEqual([]);socket.close();
});
