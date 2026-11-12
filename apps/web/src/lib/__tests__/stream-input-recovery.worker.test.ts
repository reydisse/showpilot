import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { createLiveInput, deleteLiveInput, getLiveInputStatus, getLiveInputs, resumeLiveInput } from "../stream";
import { connectDestinationsForOrg, resolveOrgLiveInput } from "../stream-destinations";
const request = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_STREAM_API_TOKEN, encryption = env.CREDENTIAL_ENCRYPTION_KEYS;
afterEach(() => { request.cookie = ""; vi.restoreAllMocks(); env.CLOUDFLARE_ACCOUNT_ID = account; env.CLOUDFLARE_STREAM_API_TOKEN = token; env.CREDENTIAL_ENCRYPTION_KEYS = encryption; });
async function fixture() {
  const prisma = getPrisma(), userId = crypto.randomUUID(), orgId = crypto.randomUUID();
  const ip = ++request.ip;
  const email = `${userId}@example.test`, password = "Stream-fixture-password-92!";
  await prisma.user.create({ data: { id: userId, name: "Stream operator", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Stream fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `198.18.${Math.floor(ip / 250)}.${ip % 250 + 1}` },
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { orgId, userId, cookie: request.cookie, input: { orgId, name: "Fixture stream", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", streamKey: "fixture-private-stream-key" } };
}
let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { authenticated = await fixture(); });


type ProviderInput = { uid:string; enabled:boolean; meta:Record<string,unknown>; rtmps:{url:string;streamKey:string}; srt:{url:string}; status:string };
let providerInputs:Map<string,ProviderInput>;
let calls:{method:string;path:string;body:unknown}[];
let loseDelete=false, loseCreate=false, loseEnable=false;
beforeEach(()=> {
  providerInputs=new Map();calls=[];loseDelete=false;loseCreate=false;loseEnable=false;
  env.CLOUDFLARE_ACCOUNT_ID="fixture-account";env.CLOUDFLARE_STREAM_API_TOKEN="fixture-token";
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=> {
    const url=new URL(String(input)),method=init?.method??"GET",base="/client/v4/accounts/fixture-account/stream/live_inputs";
    expect(url.origin).toBe("https://api.cloudflare.com");expect(url.pathname.startsWith(base)).toBe(true);
    const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,path:url.pathname,body});
    if(method==="POST" && url.pathname===base) {
      const result:ProviderInput={uid:crypto.randomUUID(),enabled:body.enabled??true,meta:body.meta,rtmps:{url:"rtmps://fixture.invalid/live",streamKey:"fixture-input-key"},srt:{url:"srt://fixture.invalid/live"},status:"idle"};
      providerInputs.set(result.uid,result);if(loseCreate){loseCreate=false;throw new Error("lost creation reply");}return Response.json({success:true,result});
    }
    if(method==="GET" && url.pathname===base)return Response.json({success:true,result:{liveInputs:[...providerInputs.values()].map(({uid,meta,enabled})=>({uid,meta,enabled}))}});
    const id=url.pathname.slice(base.length+1),result=providerInputs.get(id);
    if(!result)return new Response(null,{status:404});
    if(method==="DELETE") {providerInputs.delete(id);if(loseDelete){loseDelete=false;throw new Error("lost fixture delete reply");}return new Response(null,{status:204});}
    if(method==="PUT"){Object.assign(result,body);if(loseEnable){loseEnable=false;throw new Error("lost enable reply");}return Response.json({success:true,result});}
    if(method==="GET")return Response.json({success:true,result});
    throw new Error(`Unexpected fixture request ${method}`);
  });
});

it("replays the same creation without making a second provider input", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  const first=await createLiveInput({data}),retry=await createLiveInput({data});
  expect(retry.id).toBe(first.id);expect(providerInputs.size).toBe(1);
});

it("stores new ingest keys encrypted and returns credential-free creation metadata", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  const result=await createLiveInput({data});expect(result).not.toHaveProperty("rtmpKey");
  const key=await env.DB.prepare("SELECT rtmpKey FROM live_input WHERE orgId=? AND id=?").bind(data.orgId,result.id).first<string>("rtmpKey");
  expect(key).toMatch(/^spenc:v1:/);
  const listed=await getLiveInputs({data:{orgId:data.orgId}});expect(JSON.stringify(listed)).not.toContain("fixture-input-key");
  const managed=await getLiveInputs({data:{orgId:data.orgId,includeCredentials:true}});expect(managed[0]?.rtmpKey).toBe("fixture-input-key");
});

it("reconciles a delete that succeeded at the provider but lost its reply", async()=> {
  const input=await createLiveInput({data:{orgId:authenticated.orgId,name:"Fixture input"}});
  const data={orgId:authenticated.orgId,inputId:input.id,requestId:crypto.randomUUID()};
  loseDelete=true;await expect(deleteLiveInput({data})).rejects.toThrow();
  expect(providerInputs.size).toBe(0);
  await expect(deleteLiveInput({data})).resolves.toBeUndefined();
  expect(await env.DB.prepare("SELECT id FROM live_input WHERE orgId=? AND id=?").bind(data.orgId,input.id).first()).toBeNull();
  await expect(deleteLiveInput({data})).resolves.toBeUndefined();
});

it("keeps malformed provider health unknown instead of inventing Idle", async()=> {
  const input=await createLiveInput({data:{orgId:authenticated.orgId,name:"Fixture input"}});
  vi.mocked(fetch).mockResolvedValue(Response.json({success:true,result:{}}));
  const status=await getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});
  expect(status?.status).toBe("unknown");
});

const makeInput = () => createLiveInput({data:{orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()}});
const row = (id:string) => env.DB.prepare("SELECT id,cfInputId,status FROM live_input WHERE orgId=? AND id=?").bind(authenticated.orgId,id).first<{id:string;cfInputId:string;status:string}>();
const creationCount = () => calls.filter(call=>call.method==="POST").length;

it("recovers a lost creation reply after reload without creating another input", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  loseCreate=true;await expect(createLiveInput({data})).rejects.toThrow();
  const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;
  expect(pending.setupState).toBe("pending");expect(pending.hasRtmpKey).toBe(false);
  expect([...providerInputs.values()][0]?.enabled).toBe(false);
  expect(await resolveOrgLiveInput(data.orgId)).toBeNull();
  await resumeLiveInput({data:{orgId:data.orgId,inputId:pending.id}});
  const replay=await createLiveInput({data});expect(replay.id).toBe(pending.id);
  expect(creationCount()).toBe(1);expect([...providerInputs.values()][0]?.enabled).toBe(true);
  expect(await resolveOrgLiveInput(data.orgId)).toMatchObject({id:pending.id});
});

it("does not create again when the previous creation is absent or ambiguous in the provider list", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  loseCreate=true;await expect(createLiveInput({data})).rejects.toThrow();
  const original=[...providerInputs.values()][0]!;
  providerInputs.clear();await expect(createLiveInput({data})).rejects.toThrow(/unconfirmed or ambiguous/);
  providerInputs.set(original.uid,original);providerInputs.set("duplicate",{...original,uid:"duplicate"});
  await expect(createLiveInput({data})).rejects.toThrow(/unconfirmed or ambiguous/);
  expect(creationCount()).toBe(1);
});

it("retries input enablement without creating another input or losing its encrypted key", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  loseEnable=true;await expect(createLiveInput({data})).rejects.toThrow();
  const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;expect(pending.setupState).toBe("pending");expect(pending.hasRtmpKey).toBe(true);
  await expect(createLiveInput({data})).resolves.toMatchObject({id:pending.id});expect(creationCount()).toBe(1);
});

it("recovers and deletes a pending creation without ever enabling it", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  loseCreate=true;await expect(createLiveInput({data})).rejects.toThrow();
  const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;
  await deleteLiveInput({data:{orgId:data.orgId,inputId:pending.id,requestId:crypto.randomUUID()}});
  expect(providerInputs.size).toBe(0);expect(calls.filter(call=>call.method==="PUT")).toHaveLength(0);
  await expect(createLiveInput({data})).rejects.toThrow(/removed/);expect(creationCount()).toBe(1);
});

it("rejects changed request payloads and does not resurrect completed inputs after removal", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  const created=await createLiveInput({data});
  await expect(createLiveInput({data:{...data,name:"Different input"}})).rejects.toThrow(/different live input changes/);
  await deleteLiveInput({data:{orgId:data.orgId,inputId:created.id}});
  await expect(createLiveInput({data})).rejects.toThrow(/removed/);expect(creationCount()).toBe(1);
});

it("checks current membership and org scope on replay and never exposes keys through errors", async()=> {
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  const created=await createLiveInput({data});const count=calls.length;
  await expect(deleteLiveInput({data:{orgId:crypto.randomUUID(),inputId:created.id}})).rejects.toThrow(/Forbidden/);
  await getPrisma().member.deleteMany({where:{organizationId:data.orgId,userId:authenticated.userId}});
  await expect(createLiveInput({data})).rejects.toThrow(/Forbidden/);
  await expect(resumeLiveInput({data:{orgId:data.orgId,inputId:created.id}})).rejects.toThrow(/Forbidden/);
  await expect(getLiveInputs({data:{orgId:data.orgId,includeCredentials:true}})).rejects.toThrow(/Forbidden/);
  expect(calls.length).toBe(count);
});

it("does not make a provider input when encryption is unavailable", async()=> {
  env.CREDENTIAL_ENCRYPTION_KEYS="";
  await expect(makeInput()).rejects.toThrow();expect(calls).toHaveLength(0);
  expect(await getLiveInputs({data:{orgId:authenticated.orgId}})).toHaveLength(0);
});

it("keeps new health ahead of an older provider reply and hides provider reasons", async()=> {
  const input=await makeInput();
  let release:(response:Response)=>void=()=>{};
  const delayed=new Promise<Response>(resolve=>{release=resolve;});
  let started:()=>void=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;});
  vi.mocked(fetch).mockImplementationOnce(async()=>{started();return delayed;});
  const old=getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});await entered;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({success:true,result:{status:"client_disconnect"}}));
  expect((await getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}}))?.status).toBe("idle");
  release(Response.json({success:true,result:{status:{current:{state:"connected",reason:"fixture-secret"}}}}));
  expect((await old)?.status).toBe("unknown");expect((await row(input.id))?.status).toBe("idle");
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({success:true,result:{status:{current:{state:"failed_to_connect",reason:"fixture-secret"}}}}));
  const failure=await getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});
  expect(failure?.status).toBe("error");expect(JSON.stringify(failure)).not.toContain("fixture-secret");
});

it("rejects late health after deletion without restoring the cache or row", async()=> {
  const input=await makeInput();let release:(response:Response)=>void=()=>{};
  let started:()=>void=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;});
  vi.mocked(fetch).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;started();}));
  const old=getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});await entered;
  await deleteLiveInput({data:{orgId:authenticated.orgId,inputId:input.id}});
  release(Response.json({success:true,result:{status:"connected"}}));
  expect((await old)?.status).toBe("unknown");expect(await row(input.id)).toBeNull();
  expect(await env.DB.prepare("SELECT * FROM stream_input_health WHERE orgId=? AND inputId=?").bind(authenticated.orgId,input.id).first()).toBeNull();
});

it("blocks Go Live while input removal is pending", async()=> {
  const input=await makeInput();
  await getPrisma().streamDestination.create({data:{orgId:authenticated.orgId,name:"Destination",platform:"custom",rtmpUrl:"rtmp://fixture.invalid/live",streamKey:"key",enabled:true}});
  loseDelete=true;await expect(deleteLiveInput({data:{orgId:authenticated.orgId,inputId:input.id}})).rejects.toThrow();
  const count=calls.length;
  await expect(connectDestinationsForOrg(authenticated.orgId,input.id)).rejects.toThrow(/input changed/);
  expect(calls.length).toBe(count);expect(await resolveOrgLiveInput(authenticated.orgId)).toBeNull();
});

it("blocks deletion once Go Live has admitted an intent, before an output ID exists", async()=> {
  const input=await makeInput();
  await getPrisma().streamDestination.create({data:{orgId:authenticated.orgId,name:"Destination",platform:"custom",rtmpUrl:"rtmp://fixture.invalid/live",streamKey:"key",enabled:true}});
  let release:(response:Response)=>void=()=>{};
  let started:()=>void=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;});
  vi.mocked(fetch).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;started();}));
  const start=connectDestinationsForOrg(authenticated.orgId,input.id);await entered;
  await expect(deleteLiveInput({data:{orgId:authenticated.orgId,inputId:input.id}})).rejects.toThrow(/Stop every destination/);
  expect(await row(input.id)).not.toBeNull();expect(providerInputs.size).toBe(1);
  // Resolve the held output-list read with an explicit provider failure. No
  // external output is created by this input-admission test.
  release(new Response(null,{status:503}));expect((await start)[0]?.success).toBe(false);
});

it("bounds a hung health response body and leaves the result unknown", async()=> {
  const input=await makeInput();vi.useFakeTimers();
  try {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"result":'));}})));
    const result=getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});
    // Let the D1 admission complete before advancing the provider deadline.
    await vi.waitFor(()=>expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await result)?.status).toBe("unknown");expect((await row(input.id))?.status).toBe("unknown");
  } finally {vi.useRealTimers();}
});

it("does not call an unreadable enable response completed and can resume it", async()=> {
  const real=vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async(input,init)=>init?.method==="PUT"?Response.json({success:true,result:{}}):real(input,init));
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  await expect(createLiveInput({data})).rejects.toThrow(/did not confirm/);
  expect((await getLiveInputs({data:{orgId:data.orgId}}))[0]?.setupState).toBe("pending");
  vi.mocked(fetch).mockImplementation(real);await createLiveInput({data});expect(creationCount()).toBe(1);
});

it("rolls back input credentials when the stored-phase transaction fails, then recovers the same provider input", async()=> {
  await env.DB.exec("CREATE TRIGGER fixture_reject_input_key BEFORE UPDATE OF rtmpKey ON live_input BEGIN SELECT RAISE(ABORT,'fixture credential failure'); END;");
  const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
  try {
    await expect(createLiveInput({data})).rejects.toThrow();
    const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;
    expect(pending.hasRtmpKey).toBe(false);expect([...providerInputs.values()][0]?.enabled).toBe(false);
    expect(await env.DB.prepare("SELECT phase FROM stream_input_lifecycle WHERE orgId=? AND inputId=?").bind(data.orgId,pending.id).first("phase")).toBe("identified");
  } finally {await env.DB.exec("DROP TRIGGER fixture_reject_input_key;");}
  await createLiveInput({data});expect(creationCount()).toBe(1);
});

it("does not echo an arbitrary provider status when an input is disabled",async()=>{
 const input=await makeInput();vi.mocked(fetch).mockResolvedValueOnce(Response.json({success:true,result:{enabled:false,status:"fixture-provider-secret"}}));
 const health=await getLiveInputStatus({data:{orgId:authenticated.orgId,inputId:input.id}});
 expect(health?.status).toBe("disabled");expect(JSON.stringify(health)).not.toContain("fixture-provider-secret");
});

it("lets deletion supersede a creation in flight without enabling or duplicating it",async()=>{
 const real=vi.mocked(fetch).getMockImplementation()!;
 let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
 let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
 vi.mocked(fetch).mockImplementation(async(input,init)=>{const response=await real(input,init);if(init?.method==="POST"){entered();await held;}return response;});
 const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
 const creating=createLiveInput({data});const outcome=expect(creating).rejects.toThrow(/removed/);await started;
 const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;
 const removal={orgId:data.orgId,inputId:pending.id,requestId:crypto.randomUUID()};
 await expect(deleteLiveInput({data:removal})).rejects.toThrow(/another request/);
 release();await outcome;
 await expect(deleteLiveInput({data:removal})).resolves.toBeUndefined();
 expect(creationCount()).toBe(1);expect(providerInputs.size).toBe(0);expect(calls.some(call=>call.method==="PUT")).toBe(false);
});

it("reclaims an expired creation lease and rejects the old owner's late response",async()=>{
 const real=vi.mocked(fetch).getMockImplementation()!;
 let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
 let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
 vi.mocked(fetch).mockImplementation(async(input,init)=>{const response=await real(input,init);if(init?.method==="POST"){entered();await held;}return response;});
 const data={orgId:authenticated.orgId,name:"Fixture input",requestId:crypto.randomUUID()};
 const old=createLiveInput({data});const outcome=expect(old).rejects.toThrow(/changed|newer/);await started;
 const pending=(await getLiveInputs({data:{orgId:data.orgId}}))[0]!;
 await env.DB.prepare("UPDATE stream_input_lifecycle SET leaseUntil=0 WHERE orgId=? AND inputId=?").bind(data.orgId,pending.id).run();
 await resumeLiveInput({data:{orgId:data.orgId,inputId:pending.id}});release();await outcome;
 expect((await getLiveInputs({data:{orgId:data.orgId}}))[0]?.setupState).toBe("ready");expect(creationCount()).toBe(1);
});
