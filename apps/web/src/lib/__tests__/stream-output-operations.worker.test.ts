import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runStreamOutputCommand, outputVersions } from "../stream-output-command.server";
import { seedRelayMember } from "@/test/relay-fixtures";
import { connectDestinationsForOrg, deleteStreamDestinationForOrg, disconnectAllForOrg, setStreamDestinationEnabledForOrg } from "../stream-destinations";

vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});

type Output = { uid: string; url: string; streamKey: string; enabled: boolean };
const binding = { account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_STREAM_API_TOKEN };
let fixture: { orgId: string; destinationId: string; inputId: string; outputs: Map<string, Output>; calls: { method: string; path: string }[] };
beforeEach(async () => {
  const member = await seedRelayMember(`stream-output-${crypto.randomUUID()}`);
  const destinationId = crypto.randomUUID(), inputId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Fixture ingest','fixture-input')").bind(inputId,member.orgId).run();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Fixture destination','custom','rtmp://fixture.invalid/live','fixture-key',1,?,?)")
    .bind(destinationId,member.orgId,`pending:${Date.now()-60_000}:fixture`,inputId).run();
  const outputs = new Map<string, Output>([["fixture-output", { uid: "fixture-output", url: "rtmp://fixture.invalid/live", streamKey: "fixture-key", enabled: true }]]);
  const calls: typeof fixture.calls = [];
  env.CLOUDFLARE_ACCOUNT_ID = "fixture-account"; env.CLOUDFLARE_STREAM_API_TOKEN = "fixture-token";
  vi.spyOn(globalThis,"fetch").mockImplementation(async (input,options) => {
    const url = new URL(String(input)), method = options?.method ?? "GET";
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(url.pathname).toContain("/accounts/fixture-account/stream/live_inputs/fixture-input/outputs");
    calls.push({ method, path: url.pathname });
    if (method === "POST") {
      const body = JSON.parse(String(options?.body)) as Omit<Output,"uid">;
      expect(body.enabled).toBe(false);
      const output = { ...body, uid: crypto.randomUUID() }; outputs.set(output.uid,output);
      return Response.json({ success: true, result: output });
    }
    if (method === "PUT") {
      const output = outputs.get(url.pathname.split("/").at(-1) ?? "");
      if (!output) return new Response(null,{status:404});
      output.enabled = JSON.parse(String(options?.body)).enabled;
      return Response.json({success:true,result:output});
    }
    if (method === "GET") return Response.json({ success: true, result: [...outputs.values()] });
    if (method === "DELETE") { outputs.delete(url.pathname.split("/").at(-1) ?? ""); return Response.json({ success: true }); }
    throw new Error(`Unexpected fixture provider method ${method}`);
  });
  fixture = { orgId: member.orgId, destinationId, inputId, outputs, calls };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); env.CLOUDFLARE_ACCOUNT_ID=binding.account; env.CLOUDFLARE_STREAM_API_TOKEN=binding.token; });

it("does not report a pending destination disabled while its provider output is still live", async () => {
  await setStreamDestinationEnabledForOrg(fixture.orgId, fixture.destinationId, false);
  expect([...fixture.outputs.values()].some(output => output.enabled)).toBe(false);
  const row = await env.DB.prepare("SELECT enabled,cfOutputId,liveInputId FROM stream_destination WHERE id=? AND orgId=?").bind(fixture.destinationId,fixture.orgId).first();
  expect(row).toMatchObject({ enabled: 0, cfOutputId: "", liveInputId: "" });
});

it("reconciles a pending creation during Stop All instead of leaving a live output unrecoverable", async () => {
  const result = await disconnectAllForOrg(fixture.orgId);
  expect(result).toEqual([{ id: fixture.destinationId, success: true }]);
  expect(fixture.outputs.size).toBe(0);
  expect(fixture.calls.some(call=>call.method==="DELETE")).toBe(true);
});

async function fresh() {
  fixture.outputs.clear();
  await env.DB.prepare("UPDATE stream_destination SET cfOutputId='',liveInputId='' WHERE orgId=? AND id=?").bind(fixture.orgId,fixture.destinationId).run();
}
const options = () => ({actorId:"fixture-operator",requestId:crypto.randomUUID()});
const start = (request = options()) => connectDestinationsForOrg(fixture.orgId,fixture.inputId,request);
const stop = (request = options()) => disconnectAllForOrg(fixture.orgId,request);
const row = () => env.DB.prepare("SELECT enabled,cfOutputId,liveInputId FROM stream_destination WHERE orgId=? AND id=?").bind(fixture.orgId,fixture.destinationId).first();
function providerBehavior(override: (input: RequestInfo | URL, init: RequestInit | undefined, original: typeof fetch) => ReturnType<typeof fetch>) {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input,init)=>override(input,init,original));
}
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

it("selects without contacting the provider and completed selection retries cannot undo a later disable", async () => {
  await fresh();const request=options();
  await setStreamDestinationEnabledForOrg(fixture.orgId,fixture.destinationId,true,request);
  expect(fixture.calls).toEqual([]);
  await setStreamDestinationEnabledForOrg(fixture.orgId,fixture.destinationId,false,options());
  await setStreamDestinationEnabledForOrg(fixture.orgId,fixture.destinationId,true,request);
  expect(await row()).toMatchObject({enabled:0});expect(fixture.calls).toEqual([]);
});

it("recovers lost creation replies without a second POST and replays completed Go Live without enabling after Stop", async () => {
  await fresh();const request=options();let lost=true;
  providerBehavior(async(input,init,original)=> {
    const response=await original(input,init);
    if(init?.method==="POST" && lost) {lost=false;throw new Error("lost response fixture-key");}
    return response;
  });
  expect(await start(request)).toEqual([{id:fixture.destinationId,success:false,error:expect.not.stringContaining("fixture-key")}]);
  expect([...fixture.outputs.values()].map(output=>output.enabled)).toEqual([false]);
  expect(await start(request)).toEqual([{id:fixture.destinationId,success:true}]);
  expect(fixture.calls.filter(call=>call.method==="POST")).toHaveLength(1);
  expect([...fixture.outputs.values()].map(output=>output.enabled)).toEqual([true]);
  await stop();
  const calls=fixture.calls.length;
  expect(await start(request)).toEqual([{id:fixture.destinationId,success:true}]);
  expect(fixture.outputs.size).toBe(0);expect(fixture.calls).toHaveLength(calls);
});

it("keeps an unknown creation recoverable even when it is not yet listed, without duplicating it", async () => {
  await fresh();const request=options();let late:Output|undefined;
  providerBehavior(async(input,init,original)=> {
    if(init?.method==="POST") {late={uid:"late-output",...JSON.parse(String(init.body))};throw new Error("lost");}
    return original(input,init);
  });
  expect((await start(request))[0]?.success).toBe(false);
  const stopRequest=options();expect((await stop(stopRequest))[0]?.success).toBe(false);
  expect(await row()).toMatchObject({cfOutputId:expect.stringMatching(/^pending:/)});
  expect((await start(request))[0]?.error).toContain("newer output command");
  expect(late?.enabled).toBe(false);fixture.outputs.set(late!.uid,late!);
  expect(await stop(stopRequest)).toEqual([{id:fixture.destinationId,success:true}]);
  expect(fixture.outputs.size).toBe(0);expect(await row()).toMatchObject({cfOutputId:""});
});

it("lets Stop supersede a Go Live whose disabled creation is still in flight", async () => {
  await fresh();const entered=deferred<void>(),reply=deferred<void>();
  providerBehavior(async(input,init,original)=> {
    const response=await original(input,init);
    if(init?.method==="POST") {entered.resolve();await reply.promise;}
    return response;
  });
  const live=start();await entered.promise;
  const request=options();expect((await stop(request))[0]?.success).toBe(false);
  reply.resolve();expect((await live)[0]?.error).toContain("newer output command");
  expect([...fixture.outputs.values()].every(output=>!output.enabled)).toBe(true);
  expect(fixture.calls.some(call=>call.method==="PUT")).toBe(false);
  expect(await stop(request)).toEqual([{id:fixture.destinationId,success:true}]);
  expect(fixture.outputs.size).toBe(0);
});

it("does not adopt or delete unrelated pre-existing outputs with identical credentials", async () => {
  await fresh();fixture.outputs.set("unrelated",{uid:"unrelated",url:"rtmp://fixture.invalid/live",streamKey:"fixture-key",enabled:true});
  const request=options();let lost=true;
  providerBehavior(async(input,init,original)=> {const response=await original(input,init);if(init?.method==="POST" && lost){lost=false;throw new Error("lost");}return response;});
  expect((await start(request))[0]?.success).toBe(false);
  expect((await start(request))[0]?.success).toBe(true);
  await stop();
  expect([...fixture.outputs.keys()]).toEqual(["unrelated"]);expect(fixture.outputs.get("unrelated")?.enabled).toBe(true);
});

it("refuses ambiguous or already-owned legacy output recovery", async () => {
  fixture.outputs.set("second",{...fixture.outputs.get("fixture-output")!,uid:"second"});
  expect((await stop())[0]?.success).toBe(false);expect(fixture.outputs.size).toBe(2);
  fixture.outputs.delete("second");
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Other','custom','rtmp://fixture.invalid/live','fixture-key',1,'fixture-output',?)").bind(crypto.randomUUID(),fixture.orgId,fixture.inputId).run();
  await expect(setStreamDestinationEnabledForOrg(fixture.orgId,fixture.destinationId,false)).rejects.toThrow("ambiguous");
  expect(fixture.outputs.size).toBe(1);
});

it("keeps failed deletion state and can replay a completed delete after the row is gone", async () => {
  const request=options();let denied=true;
  providerBehavior(async(input,init,original)=> denied && init?.method==="DELETE"?new Response("provider-secret",{status:503}):original(input,init));
  await expect(deleteStreamDestinationForOrg(fixture.orgId,fixture.destinationId,request)).rejects.toThrow("did not confirm");
  expect(await row()).not.toBeNull();expect(fixture.outputs.size).toBe(1);
  denied=false;
  await deleteStreamDestinationForOrg(fixture.orgId,fixture.destinationId,request);
  expect(await row()).toBeNull();expect(fixture.outputs.size).toBe(0);
  const calls=fixture.calls.length;
  await deleteStreamDestinationForOrg(fixture.orgId,fixture.destinationId,request);
  expect(fixture.calls).toHaveLength(calls);
});

it("converges a lost DELETE response through a provider 404", async () => {
  await fresh();await start();const request=options();let lost=true;
  providerBehavior(async(input,init,original)=> {
    if(init?.method==="DELETE" && !fixture.outputs.size)return new Response(null,{status:404});
    const response=await original(input,init);
    if(init?.method==="DELETE" && lost){lost=false;throw new Error("lost");}return response;
  });
  expect((await stop(request))[0]?.success).toBe(false);expect(await row()).toMatchObject({cfOutputId:expect.not.stringMatching(/^$/)});
  expect((await stop(request))[0]?.success).toBe(true);expect(await row()).toMatchObject({cfOutputId:"",liveInputId:""});
});

it("retains frozen Stop All targets and completed results so retry cannot stop a later broadcast", async () => {
  await fresh();await start();
  const other=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Other','custom','rtmp://other.invalid/live','other-key',1,'other-output',?)").bind(other,fixture.orgId,fixture.inputId).run();
  fixture.outputs.set("other-output",{uid:"other-output",url:"rtmp://other.invalid/live",streamKey:"other-key",enabled:true});
  let deny=true;providerBehavior(async(input,init,original)=>init?.method==="DELETE" && String(input).endsWith("/other-output") && deny?new Response(null,{status:503}):original(input,init));
  const request=options(), first=await stop(request);
  expect(first).toContainEqual({id:fixture.destinationId,success:true});expect(first).toContainEqual({id:other,success:false,error:expect.any(String)});
  const version=(await outputVersions(fixture.orgId))[fixture.destinationId]!;
  await connectDestinationsForOrg(fixture.orgId,fixture.inputId,{...options(),targets:[{id:fixture.destinationId,version}]});
  deny=false;expect((await stop(request)).every(result=>result.success)).toBe(true);
  expect([...fixture.outputs.values()].map(output=>output.enabled)).toEqual([true]);
});

it("scopes targets to the organization and rejects changed requests or stale confirmed versions", async () => {
  await fresh();const request=options();await start(request);await stop();
  await expect(runStreamOutputCommand({...request,orgId:fixture.orgId,action:"stop"})).rejects.toThrow("different output changes");
  await expect(connectDestinationsForOrg(fixture.orgId,fixture.inputId,{...options(),targets:[{id:fixture.destinationId,version:""}]})).rejects.toThrow("newer output command");
  const other=await seedRelayMember(`stream-other-${crypto.randomUUID()}`);
  await expect(runStreamOutputCommand({...options(),orgId:other.orgId,action:"delete",destinationId:fixture.destinationId})).rejects.toThrow("Destination not found");
  expect(await row()).not.toBeNull();
});

it("serializes concurrent Go Live attempts and never stores credentials in the command records", async () => {
  await fresh();const request=options();
  const results=await Promise.all([start(request),start(request)]);
  expect(results.flat().some(result=>result.success)).toBe(true);
  expect(fixture.calls.filter(call=>call.method==="POST")).toHaveLength(1);
  const receipts=await env.DB.prepare("SELECT * FROM stream_output_command WHERE orgId=?").bind(fixture.orgId).all();
  const intents=await env.DB.prepare("SELECT * FROM stream_output_intent WHERE orgId=?").bind(fixture.orgId).all();
  expect(JSON.stringify([receipts,intents])).not.toContain("fixture-key");
});

it("claims identical destination credentials so uncertain creation recovery has a single owner", async () => {
  await fresh();const other=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled) VALUES(?,?,'Other','custom','rtmp://fixture.invalid/live','fixture-key',1)").bind(other,fixture.orgId).run();
  const results=await start();
  expect(results.filter(result=>result.success)).toHaveLength(1);expect(fixture.outputs.size).toBe(1);
  expect(results.find(result=>!result.success)?.error).toContain("owns these output credentials");
});

it("bounds a stalled provider response body and retains the output for Retry", async () => {
  await fresh();await start();
  const entered=deferred<void>();let closeBody: (()=>void) | undefined;
  providerBehavior(async(input,init,original)=> {
    if(init?.method!=="DELETE")return original(input,init);
    entered.resolve();return new Response(new ReadableStream({start(controller){closeBody=()=>controller.close();}}));
  });
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const operation=stop();await entered.promise;await vi.advanceTimersByTimeAsync(5_001);
  expect((await operation)[0]?.error).toContain("five seconds");
  expect(await row()).toMatchObject({cfOutputId:expect.not.stringMatching(/^$/)});
  closeBody?.();
});


it("Stop All fences Go Live before provider creation has even begun", async () => {
  await fresh();const entered=deferred<void>(),reply=deferred<void>();let held=false;
  providerBehavior(async(input,init,original)=> {
    if(init?.method==="GET" && !held) {held=true;entered.resolve();await reply.promise;}
    return original(input,init);
  });
  const live=start();await entered.promise;
  const request=options();expect((await stop(request))[0]?.success).toBe(false);
  reply.resolve();expect((await live)[0]?.error).toContain("newer output command");
  expect(fixture.calls.some(call=>call.method==="POST")).toBe(false);
  expect(await stop(request)).toEqual([{id:fixture.destinationId,success:true}]);
});

it("never enables an old output on a different live input", async () => {
  await fresh();await start();const other=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Other ingest','other-input')").bind(other,fixture.orgId).run();
  const calls=fixture.calls.length;
  expect((await connectDestinationsForOrg(fixture.orgId,other,options()))[0]?.error).toContain("Stop this destination");
  expect(fixture.calls).toHaveLength(calls);
});

it("does not stop at the first slow or failed destination", async () => {
  await fresh();await start();const other=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Other','custom','rtmp://other.invalid/live','other-key',1,'other-output',?)").bind(other,fixture.orgId,fixture.inputId).run();
  fixture.outputs.set("other-output",{uid:"other-output",url:"rtmp://other.invalid/live",streamKey:"other-key",enabled:true});
  const entered=deferred<void>(),doneOther=deferred<void>(),release=deferred<void>();
  providerBehavior(async(input,init,original)=> {
    if(init?.method==="DELETE" && !String(input).endsWith("/other-output")) {entered.resolve();await release.promise;return new Response(null,{status:503});}
    const response=await original(input,init);if(init?.method==="DELETE")doneOther.resolve();return response;
  });
  const operation=stop();await entered.promise;await doneOther.promise;
  expect(fixture.outputs.has("other-output")).toBe(false);
  release.resolve();const results=await operation;
  expect(results).toContainEqual({id:other,success:true});expect(results).toContainEqual({id:fixture.destinationId,success:false,error:expect.any(String)});
});

it("does not let an expired execution lease overwrite a newer Stop", async () => {
  await fresh();const entered=deferred<void>(),release=deferred<void>();
  providerBehavior(async(input,init,original)=> {
    const response=await original(input,init);
    if(init?.method==="POST") {entered.resolve();await release.promise;}
    return response;
  });
  const live=start();await entered.promise;
  await env.DB.prepare("UPDATE stream_output_intent SET leaseUntil=0 WHERE orgId=? AND destinationId=?").bind(fixture.orgId,fixture.destinationId).run();
  expect((await stop())[0]?.success).toBe(true);
  release.resolve();expect((await live)[0]?.success).toBe(false);
  expect(fixture.outputs.size).toBe(0);expect(await row()).toMatchObject({cfOutputId:""});
  expect(fixture.calls.some(call=>call.method==="PUT")).toBe(false);
});

it("keeps a malformed provider listing unconfirmed instead of treating it as empty", async () => {
  providerBehavior(async(_input,init)=>Response.json(init?.method==="GET"?{success:true,result:[{uid:"fixture-output"}]}:{success:true}));
  const request=options();expect((await stop(request))[0]?.error).toContain("unreadable output list");
  expect(await row()).toMatchObject({cfOutputId:expect.stringMatching(/^pending:/)});
  expect(fixture.outputs.size).toBe(1);
});

it("stops available outputs even when another confirmed target was removed or has a missing input", async () => {
  await fresh();await start();
  const damaged=crypto.randomUUID(), removed=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Damaged','custom','rtmp://other.invalid/live','other-key',1,'damaged-output','missing-input')").bind(damaged,fixture.orgId).run();
  const results=await disconnectAllForOrg(fixture.orgId,{...options(),targets:[{id:damaged,version:""},{id:removed,version:""},{id:fixture.destinationId,version:""}]});
  expect(results).toContainEqual({id:fixture.destinationId,success:true});
  expect(results).toContainEqual({id:damaged,success:false,error:expect.stringContaining("input")});
  expect(results).toContainEqual({id:removed,success:false,error:expect.stringContaining("not found")});
  expect(fixture.outputs.size).toBe(0);
});


it("reports an independent claim failure without abandoning the other Stop All destinations", async () => {
  await fresh();await start();const damaged=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Other','custom','rtmp://other.invalid/live','other-key',1,'other-output',?)").bind(damaged,fixture.orgId,fixture.inputId).run();
  await env.DB.prepare(`CREATE TRIGGER fixture_output_claim BEFORE UPDATE ON stream_output_intent WHEN NEW.orgId='${fixture.orgId}' AND NEW.destinationId='${damaged}' AND NEW.leaseId<>'' BEGIN SELECT RAISE(ABORT,'fixture secret error'); END;`).run();
  try {
    const results=await stop();
    expect(results).toContainEqual({id:fixture.destinationId,success:true});
    expect(results).toContainEqual({id:damaged,success:false,error:expect.stringContaining("could not be confirmed")});
    expect(JSON.stringify(results)).not.toContain("fixture secret");expect(fixture.outputs.size).toBe(0);
  } finally { await env.DB.exec("DROP TRIGGER fixture_output_claim"); }
});

it("does not retry a rejected Go Live with credentials edited by another operator", async () => {
  await fresh();const request=options();let reject=true;
  providerBehavior(async(input,init,original)=>init?.method==="POST" && reject?new Response(null,{status:400}):original(input,init));
  expect((await start(request))[0]?.success).toBe(false);
  await env.DB.prepare("UPDATE stream_destination SET rtmpUrl='rtmp://changed.invalid/live' WHERE orgId=? AND id=?").bind(fixture.orgId,fixture.destinationId).run();
  reject=false;const calls=fixture.calls.length;
  expect((await start(request))[0]?.error).toContain("settings changed");
  expect(fixture.calls).toHaveLength(calls);expect(fixture.outputs.size).toBe(0);
});

it("rejects a confirmation whose destination configuration changed before Go Live reached the server", async () => {
  await fresh();const version=(await outputVersions(fixture.orgId))[fixture.destinationId]??"";
  await env.DB.prepare("UPDATE stream_destination SET rtmpUrl='rtmp://changed.invalid/live' WHERE orgId=? AND id=?").bind(fixture.orgId,fixture.destinationId).run();
  await expect(connectDestinationsForOrg(fixture.orgId,fixture.inputId,{...options(),targets:[{id:fixture.destinationId,version}]})).rejects.toThrow("Refresh");
  expect(fixture.calls).toEqual([]);
});

it("rolls back all command intents with the receipt when target preparation fails", async () => {
  await fresh();const other=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled) VALUES(?,?,'Other','custom','rtmp://other.invalid/live','other-key',1)").bind(other,fixture.orgId).run();
  const versions=await outputVersions(fixture.orgId);
  const request={...options(),targets:[fixture.destinationId,other].map(id=>({id,version:versions[id]!}))};
  await env.DB.prepare(`CREATE TRIGGER fixture_output_prepare BEFORE INSERT ON stream_output_intent WHEN NEW.orgId='${fixture.orgId}' AND NEW.destinationId='${other}' AND EXISTS(SELECT 1 FROM stream_output_intent WHERE orgId='${fixture.orgId}' AND destinationId='${fixture.destinationId}') BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;`).run();
  try {
    await expect(connectDestinationsForOrg(fixture.orgId,fixture.inputId,request)).rejects.toThrow("being prepared");
    expect(await env.DB.prepare("SELECT COUNT(*) FROM stream_output_command WHERE orgId=?").bind(fixture.orgId).first("COUNT(*)")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM stream_output_intent WHERE orgId=?").bind(fixture.orgId).first("COUNT(*)")).toBe(0);
    expect(fixture.calls).toEqual([]);
  } finally {await env.DB.exec("DROP TRIGGER fixture_output_prepare");}
  expect((await connectDestinationsForOrg(fixture.orgId,fixture.inputId,request)).every(result=>result.success)).toBe(true);
  expect(fixture.outputs.size).toBe(2);
});
