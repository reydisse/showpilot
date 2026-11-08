import { nextFixtureAddress } from "@/test/fixture-address";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { addStreamDestination, updateStreamDestination, toggleStreamDestination, deleteStreamDestination, disconnectAllDestinations, connectDestinationsToInput, connectDestinationsForOrg } from "../stream-destinations";
import { CredentialVault } from "../credential-vault.server";
import { readStreamDestinationKey } from "../stream-destination-write.server";
import { handleMobileApi } from "../mobile-api.server";

const request = vi.hoisted(() => ({ cookie: "" }));
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
  const email = `${userId}@example.test`, password = "Stream-fixture-password-92!";
  await prisma.user.create({ data: { id: userId, name: "Stream operator", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Stream fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { orgId, userId, cookie: request.cookie, input: { orgId, name: "Fixture stream", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", streamKey: "fixture-private-stream-key" } };
}
let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { authenticated = await fixture(); });

it("recovers a repeated creation without making another destination", async () => {
  const f = authenticated; const data = { ...f.input, requestId: crypto.randomUUID() };
  const first = await addStreamDestination({ data });
  const retry = await addStreamDestination({ data });
  expect(retry.id).toBe(first.id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM stream_destination WHERE orgId=?").bind(f.orgId).first("n")).toBe(1);
});

it("never returns plaintext or encrypted stream keys from creation, metadata updates or toggles", async () => {
  const f = authenticated;
  const first = await addStreamDestination({ data: f.input });
  const changed = await updateStreamDestination({ data: { orgId: f.orgId, id: first.id, updates: { name: "Renamed" } } });
  expect(JSON.stringify([first,changed])).not.toContain(f.input.streamKey);
  expect(first).not.toHaveProperty("streamKey");
  expect(changed).not.toHaveProperty("streamKey");
  const enabled = await toggleStreamDestination({ data: { id: first.id, enabled: true } });
  expect(enabled).not.toHaveProperty("streamKey");
  expect(enabled).toMatchObject({ enabled: true, hasStreamKey: true });
  await env.DB.prepare("UPDATE stream_destination SET streamKey=? WHERE id=? AND orgId=?").bind(f.input.streamKey,first.id,f.orgId).run();
  const disabled = await toggleStreamDestination({ data: { id: first.id, enabled: false } });
  expect(disabled).not.toHaveProperty("streamKey");
  expect(JSON.stringify(disabled)).not.toContain(f.input.streamKey);
});

async function stored(orgId: string,id: string) {
  const row = await env.DB.prepare("SELECT id,orgId,name,streamKey,enabled FROM stream_destination WHERE orgId=? AND id=?")
    .bind(orgId,id).first<{ id: string; orgId: string; name: string; streamKey: string; enabled: number }>();
  if (!row) throw new Error("Fixture destination missing");
  return row;
}

it("coalesces racing creates and rejects a changed request without storing credentials in its receipt", async () => {
  const f = authenticated, data = { ...f.input, requestId: crypto.randomUUID() };
  const [one,two] = await Promise.all([addStreamDestination({ data }),addStreamDestination({ data })]);
  expect(one.id).toBe(two.id);
  await expect(addStreamDestination({ data: { ...data,streamKey: "different-key" } })).rejects.toThrow("different destination changes");
  const row = await stored(f.orgId,one.id);
  expect(row.streamKey).toMatch(/^spenc:v1:/);expect(row.streamKey).not.toContain(f.input.streamKey);
  expect(await readStreamDestinationKey(row)).toBe(f.input.streamKey);
  await expect(readStreamDestinationKey({ ...row,id: "different-destination" })).rejects.toThrow("storage identity");
  const receipt = await env.DB.prepare("SELECT * FROM stream_destination_write_receipt WHERE orgId=?").bind(f.orgId).first<{fingerprint:string}>();
  expect(receipt?.fingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(receipt)).not.toContain(f.input.streamKey);
  expect(row.enabled).toBe(0);
});

it("keeps blank credentials and never replays a save over later edits or a deleted destination", async () => {
  const f = authenticated, creation = { ...f.input,requestId: crypto.randomUUID() };
  const row = await addStreamDestination({ data: creation });
  const firstKey = (await stored(f.orgId,row.id)).streamKey;
  const update = { orgId:f.orgId,id:row.id,requestId:crypto.randomUUID(),updates:{name:"First edit",streamKey:""} };
  await updateStreamDestination({ data:update });
  expect((await stored(f.orgId,row.id)).streamKey).toBe(firstKey);
  await updateStreamDestination({ data:{orgId:f.orgId,id:row.id,updates:{name:"Later edit",streamKey:"later-key"}} });
  await updateStreamDestination({ data:update });
  expect((await stored(f.orgId,row.id)).name).toBe("Later edit");
  expect(await readStreamDestinationKey(await stored(f.orgId,row.id))).toBe("later-key");
  await env.DB.prepare("DELETE FROM stream_destination WHERE id=? AND orgId=?").bind(row.id,f.orgId).run();
  await expect(addStreamDestination({ data:creation })).rejects.toThrow("will not recreate");
  await expect(updateStreamDestination({ data:update })).rejects.toThrow("will not recreate");
});

it("rolls back a failed save with its receipt and preserves preparation conflicts", async () => {
  const f = authenticated;const row=await addStreamDestination({data:f.input});
  const data={orgId:f.orgId,id:row.id,requestId:crypto.randomUUID(),updates:{name:"Rejected edit"}};
  await env.DB.prepare(`CREATE TRIGGER fixture_stream_failure BEFORE UPDATE ON stream_destination WHEN NEW.orgId='${f.orgId}' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;`).run();
  try { await expect(updateStreamDestination({data})).rejects.toThrow("could not be confirmed"); }
  finally { await env.DB.exec("DROP TRIGGER fixture_stream_failure"); }
  expect((await stored(f.orgId,row.id)).name).toBe(f.input.name);
  expect(await env.DB.prepare("SELECT requestId FROM stream_destination_write_receipt WHERE orgId=? AND requestId=?").bind(f.orgId,data.requestId).first()).toBeNull();
  await updateStreamDestination({data});
  const encrypt=CredentialVault.prototype.encrypt;
  vi.spyOn(CredentialVault.prototype,"encrypt").mockImplementationOnce(async function(this:CredentialVault,scope,plaintext) {
    await env.DB.prepare("UPDATE stream_destination SET name='Concurrent edit' WHERE id=? AND orgId=?").bind(row.id,f.orgId).run();
    return encrypt.call(this,scope,plaintext);
  });
  await expect(updateStreamDestination({data:{orgId:f.orgId,id:row.id,updates:{name:"Stale edit",streamKey:"stale-key"}}})).rejects.toThrow("changed elsewhere");
  expect((await stored(f.orgId,row.id)).name).toBe("Concurrent edit");
  expect(await readStreamDestinationKey(await stored(f.orgId,row.id))).toBe(f.input.streamKey);
});

it("rechecks permissions on Retry and never edits another organization's destination", async () => {
  const f=authenticated,data={...f.input,requestId:crypto.randomUUID()};
  const mine=await addStreamDestination({data});
  const other=await fixture();const foreign=await addStreamDestination({data:other.input});request.cookie=f.cookie;
  await expect(updateStreamDestination({data:{orgId:f.orgId,id:foreign.id,updates:{name:"Cross-org"}}})).rejects.toThrow("Destination not found");
  await expect(updateStreamDestination({data:{orgId:other.orgId,id:foreign.id,updates:{name:"Cross-org"}}})).rejects.toThrow("Forbidden");
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.userId).run();
  await expect(addStreamDestination({data})).rejects.toThrow("Forbidden");
  expect((await stored(f.orgId,mine.id)).name).toBe(f.input.name);
});

it("requires the encryption key for new secrets, keeps existing metadata writable and decrypts only for provider use", async () => {
  const f=authenticated;const row=await addStreamDestination({data:f.input});
  env.CREDENTIAL_ENCRYPTION_KEYS=undefined;
  await updateStreamDestination({data:{orgId:f.orgId,id:row.id,updates:{name:"Metadata only",streamKey:""}}});
  await expect(updateStreamDestination({data:{orgId:f.orgId,id:row.id,updates:{streamKey:"new-secret"}}})).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEYS");
  env.CREDENTIAL_ENCRYPTION_KEYS=encryption;env.CLOUDFLARE_ACCOUNT_ID="fixture-account";env.CLOUDFLARE_STREAM_API_TOKEN="fixture-token";
  const inputId=crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Fixture ingest','fixture-input')").bind(inputId,f.orgId).run();
  await env.DB.prepare("UPDATE stream_destination SET enabled=1 WHERE id=? AND orgId=?").bind(row.id,f.orgId).run();
  const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async (_url,options)=> options?.method==="POST"
    ? Response.json({result:{uid:"fixture-output"}}) : options?.method==="PUT" ? Response.json({success:true}) : Response.json({result:[]}));
  expect(await connectDestinationsForOrg(f.orgId,inputId)).toEqual([{id:row.id,success:true}]);
  const creation=fetch.mock.calls.find(([,options])=>options?.method==="POST");
  expect(JSON.parse(String(creation?.[1]?.body)).streamKey).toBe(f.input.streamKey);
  await expect(updateStreamDestination({data:{orgId:f.orgId,id:row.id,updates:{streamKey:"blocked"}}})).rejects.toThrow("Disable this destination");
});

it("uses the same encrypted receipt-backed save through mobile with retained request IDs", async () => {
  const f=authenticated;const requestId=crypto.randomUUID();
  const send=(id:string|undefined,body:object)=>handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations${id?`/${id}`:""}?orgId=${f.orgId}`,{
    method:"POST",headers:{"Content-Type":"application/json",Origin:"https://app.showpilot.tech",Cookie:request.cookie},body:JSON.stringify(body),
  }),{DB:env.DB});
  const response=await send(undefined,{...f.input,requestId});expect(response?.status).toBe(200);
  const result=await response!.json() as {id:string};
  const retry=await send(undefined,{...f.input,requestId});expect(await retry!.json()).toEqual({ok:true,id:result.id});
  const update=await send(result.id,{...f.input,name:"Mobile edit",streamKey:"",requestId:crypto.randomUUID()});expect(update?.status).toBe(200);
  expect(await readStreamDestinationKey(await stored(f.orgId,result.id))).toBe(f.input.streamKey);
  expect((await stored(f.orgId,result.id)).name).toBe("Mobile edit");
  const invalid=await send(result.id,{...f.input,name:"Invalid edit",requestId:"short"});expect(invalid?.status).toBe(400);
});

it("refuses Go Live when credentials change after its snapshot but before its provider claim", async () => {
  const f = authenticated;
  const row = await addStreamDestination({ data: f.input });
  const inputId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Fixture ingest','fixture-input')").bind(inputId,f.orgId).run();
  await env.DB.prepare("UPDATE stream_destination SET enabled=1 WHERE id=? AND orgId=?").bind(row.id,f.orgId).run();
  env.CLOUDFLARE_ACCOUNT_ID = "fixture-account"; env.CLOUDFLARE_STREAM_API_TOKEN = "fixture-token";
  const vault = await CredentialVault.fromSecret(encryption);
  const replacement = await vault.encrypt({ kind: "stream-destination", orgId: f.orgId, destinationId: row.id }, "concurrent-key");
  const decrypt = CredentialVault.prototype.decrypt;
  vi.spyOn(CredentialVault.prototype,"decrypt").mockImplementationOnce(async function(this: CredentialVault, scope, value) {
    await env.DB.prepare("UPDATE stream_destination SET streamKey=? WHERE id=? AND orgId=?").bind(replacement,row.id,f.orgId).run();
    return decrypt.call(this,scope,value);
  });
  const fetch = vi.spyOn(globalThis,"fetch").mockImplementation(async (_url,options) => options?.method === "POST"
    ? Response.json({ result: { uid: "stale-output" } }) : options?.method === "PUT" ? Response.json({ success: true }) : Response.json({ result: [] }));
  expect(await connectDestinationsForOrg(f.orgId,inputId)).toEqual([{ id: row.id, success: false, error: expect.stringContaining("changed while Go Live") }]);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readStreamDestinationKey(await stored(f.orgId,row.id))).toBe("concurrent-key");
  expect(await env.DB.prepare("SELECT cfOutputId FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId,row.id).first("cfOutputId")).toBe("");
});


it("rechecks authority on public output Retry and returns a deletion receipt after the row is gone", async () => {
  const f=authenticated;const destination=await addStreamDestination({data:f.input});
  const data={orgId:f.orgId,id:destination.id,requestId:crypto.randomUUID()};
  await deleteStreamDestination({data});await deleteStreamDestination({data});
  const stop={orgId:f.orgId,requestId:crypto.randomUUID()};await disconnectAllDestinations({data:stop});
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.userId).run();
  await expect(deleteStreamDestination({data})).rejects.toThrow("Forbidden");
  await expect(disconnectAllDestinations({data:stop})).rejects.toThrow("Forbidden");
  await expect(connectDestinationsToInput({data:{orgId:f.orgId,liveInputId:"foreign-input",requestId:crypto.randomUUID()}})).rejects.toThrow("Forbidden");
});

it("mobile removal and selection keep caller request IDs and validate them before mutations", async () => {
  const f=authenticated;const destination=await addStreamDestination({data:f.input});
  const send=(body:object)=>handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/streaming/destinations/${destination.id}?orgId=${f.orgId}`,{
    method:"POST",headers:{"Content-Type":"application/json",Origin:"https://app.showpilot.tech",Cookie:request.cookie},body:JSON.stringify(body),
  }),{DB:env.DB});
  expect((await send({action:"toggle",enabled:true,requestId:"short"}))?.status).toBe(400);
  const selection={action:"toggle",enabled:true,requestId:crypto.randomUUID()};
  expect((await send(selection))?.status).toBe(200);
  expect((await send({action:"toggle",enabled:false,requestId:crypto.randomUUID()}))?.status).toBe(200);
  expect((await send(selection))?.status).toBe(200);
  expect((await stored(f.orgId,destination.id)).enabled).toBe(0);
  const removal={action:"remove",requestId:crypto.randomUUID()};
  expect((await send(removal))?.status).toBe(200);expect((await send(removal))?.status).toBe(200);
  expect(await env.DB.prepare("SELECT id FROM stream_destination WHERE orgId=? AND id=?").bind(f.orgId,destination.id).first()).toBeNull();
});
