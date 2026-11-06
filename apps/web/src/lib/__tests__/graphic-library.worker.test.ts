import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture", email: "fixture@example.test" } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
import { mutateGraphicLibrary } from "../graphics";
import { applyGraphicLibraryOperation } from "../graphic-library.server";
const content = { name: "Original", title: "Original", subtitle: "", style: "{}" };
async function fixture() {
  const f = await seedRelayMember(`graphic-library-${crypto.randomUUID()}`);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(f.orgId).run();
  auth.userId = f.userId;
  return f;
}
const titleOf = (orgId: string, id: string) => env.DB.prepare("SELECT title FROM graphic_template WHERE orgId=? AND id=?").bind(orgId,id).first<{title:string}>();
it("deduplicates concurrent creates and rejects a changed request body", async () => {
  const f=await fixture(), requestId=crypto.randomUUID();
  const data = { orgId:f.orgId, requestId, operation: {kind:"create" as const, content} };
  const results=await Promise.all([applyGraphicLibraryOperation(env.DB,data),applyGraphicLibraryOperation(env.DB,data)]);
  expect(results[0]).toEqual(results[1]); expect(results[0].id).toBe(requestId);
  expect(await titleOf(f.orgId,requestId)).toEqual({title:"Original"});
  await expect(mutateGraphicLibrary({data:{...data,operation:{kind:"create",content:{...content,title:"Changed"}}}})).rejects.toThrow("different graphics change");
  expect(await titleOf(f.orgId,requestId)).toEqual({title:"Original"});
});
it("acknowledges a replayed update without overwriting a later update", async () => {
  const f=await fixture(), id=crypto.randomUUID();
  await mutateGraphicLibrary({data:{orgId:f.orgId,requestId:id,operation:{kind:"create",content}}});
  const first={orgId:f.orgId,requestId:crypto.randomUUID(),operation:{kind:"update" as const,id,content:{...content,title:"First"}}};
  await mutateGraphicLibrary({data:first});
  await mutateGraphicLibrary({data:{...first,requestId:crypto.randomUUID(),operation:{...first.operation,content:{...content,title:"Later"}}}});
  await mutateGraphicLibrary({data:first});
  expect(await titleOf(f.orgId,id)).toEqual({title:"Later"});
});
it("retains receipts after deletion so a late create or update cannot resurrect the graphic", async () => {
  const f=await fixture(), id=crypto.randomUUID();
  const create={orgId:f.orgId,requestId:id,operation:{kind:"create" as const,content}};
  await mutateGraphicLibrary({data:create});
  const update={orgId:f.orgId,requestId:crypto.randomUUID(),operation:{kind:"update" as const,id,content}};
  await mutateGraphicLibrary({data:update});
  const remove={orgId:f.orgId,requestId:crypto.randomUUID(),operation:{kind:"delete" as const,id}};
  await mutateGraphicLibrary({data:remove});
  await mutateGraphicLibrary({data:create}); await mutateGraphicLibrary({data:update}); await mutateGraphicLibrary({data:remove});
  expect(await titleOf(f.orgId,id)).toBeNull();
});
it("rejects missing updates without recording a false successful receipt", async () => {
  const f=await fixture(), requestId=crypto.randomUUID();
  await expect(mutateGraphicLibrary({data:{orgId:f.orgId,requestId,operation:{kind:"update",id:"missing",content}}})).rejects.toThrow("no longer exists");
  expect(await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?").bind(f.orgId,`graphic-library:${requestId}`).first()).toBeNull();
});
it("rechecks access on retries and scopes mutations to the authorized organization", async () => {
  const own=await fixture(), other=await fixture(); auth.userId=own.userId;
  const id=crypto.randomUUID(), data={orgId:own.orgId,requestId:id,operation:{kind:"create" as const,content}};
  await mutateGraphicLibrary({data});
  await expect(mutateGraphicLibrary({data:{...data,orgId:other.orgId}})).rejects.toThrow();
  auth.userId=other.userId;
  await mutateGraphicLibrary({data:{orgId:other.orgId,requestId:crypto.randomUUID(),operation:{kind:"delete",id}}});
  expect(await titleOf(own.orgId,id)).toEqual({title:"Original"});
  await expect(mutateGraphicLibrary({data})).rejects.toThrow();
});
it("rolls the receipt back if the library write fails and succeeds on the same retry", async () => {
  const f=await fixture(), id=crypto.randomUUID(), data={orgId:f.orgId,requestId:id,operation:{kind:"create" as const,content}};
  const trigger=`fail_graphic_${id.replaceAll("-","")}`;
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON graphic_template WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`).run();
  try { await expect(mutateGraphicLibrary({data})).rejects.toThrow(); }
  finally { await env.DB.prepare(`DROP TRIGGER ${trigger}`).run(); }
  expect(await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?").bind(f.orgId,`graphic-library:${id}`).first()).toBeNull();
  expect(await mutateGraphicLibrary({data})).toEqual({requestId:id,id});
});
