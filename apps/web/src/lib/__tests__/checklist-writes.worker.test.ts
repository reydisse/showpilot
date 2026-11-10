import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { applyChecklistWrite } from "../checklist-writes.server";
import { checklistWriteSchema, type ChecklistOperation, type ChecklistWrite } from "../checklist-writes";
import { setChecklistEntryCategory } from "../checklist-toggle.server";
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
import { mutateChecklist } from "../data";
const date = "2026-11-06";
const noDraft = async () => [];
async function fixture() {
  const f = await seedRelayMember(`checks-${crypto.randomUUID()}`);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(f.orgId).run();
  const showId=crypto.randomUUID(), otherShowId=crypto.randomUUID();
  for (const id of [showId,otherShowId]) await env.DB.prepare("INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Checklist fixture')").bind(id,f.orgId,date).run();
  auth.userId=f.userId;
  const request=(operation:ChecklistOperation):ChecklistWrite=>({orgId:f.orgId,showId,serviceDate:date,requestId:crypto.randomUUID(),operation});
  const add=request({kind:"add",label:"Line check",category:"audio"});
  await mutateChecklist({data:add});
  return {...f,showId,otherShowId,request,add};
}
const rows=async(orgId:string,showId:string)=>(await env.DB.prepare("SELECT id, checked, checkedBy, checkedAt, category, revision, templateId FROM checklist_entry WHERE orgId=? AND showId=?").bind(orgId,showId).all<{id:string;checked:number;checkedBy:string|null;checkedAt:string|null;category:string;revision:number;templateId:string}>()).results;
const expected=(row:{id:string;category:string;revision:number})=>({id:row.id,expectedCategory:row.category,expectedRevision:row.revision});
it("deduplicates concurrent adds and acknowledges an old create after deletion without recreating it",async()=>{
  const f=await fixture(), add=f.request({kind:"add",label:"Camera check",category:"video"});
  expect(await Promise.all([applyChecklistWrite(env.DB,add,"One",noDraft),applyChecklistWrite(env.DB,add,"Two",noDraft)])).toEqual([{requestId:add.requestId,outcome:"applied"},{requestId:add.requestId,outcome:"applied"}]);
  const entries=await rows(f.orgId,f.showId); expect(entries).toHaveLength(2);
  const entry=entries.find(row=>row.category==="video")!;
  const remove=f.request({kind:"delete",...expected(entry)});
  await mutateChecklist({data:{...add,showId:f.otherShowId,requestId:crypto.randomUUID()}});
  await mutateChecklist({data:remove}); await mutateChecklist({data:remove});
  expect(await rows(f.orgId,f.otherShowId)).toHaveLength(1);
  expect(await env.DB.prepare("SELECT id FROM checklist_template WHERE orgId=? AND id=?").bind(f.orgId,entry.templateId).first()).not.toBeNull();
  await mutateChecklist({data:add}); expect(await rows(f.orgId,f.showId)).toHaveLength(1);
  await expect(mutateChecklist({data:{...add,operation:{kind:"add",label:"Changed",category:"general"}}})).rejects.toThrow("different checklist change");
});
it("keeps a newer toggle and its completion metadata when an old response is lost",async()=>{
  const f=await fixture(); let [row]=await rows(f.orgId,f.showId);
  const first=f.request({kind:"toggle",...expected(row),checked:true});
  await applyChecklistWrite(env.DB,first,"First",noDraft);
  [row]=await rows(f.orgId,f.showId); expect(row).toMatchObject({checked:1,checkedBy:"First",revision:1}); expect(row.checkedAt).not.toBeNull();
  await mutateChecklist({data:f.request({kind:"toggle",...expected(row),checked:false})});
  await applyChecklistWrite(env.DB,first,"Retrying operator",noDraft);
  expect((await rows(f.orgId,f.showId))[0]).toMatchObject({checked:0,checkedBy:null,checkedAt:null,revision:2});
});
it("rejects stale edits atomically, including a category changed through the mobile API",async()=>{
  const f=await fixture(), [row]=await rows(f.orgId,f.showId);
  const first=f.request({kind:"category",...expected(row),category:"video"}), second=f.request({kind:"delete",...expected(row)});
  const results=await Promise.all([applyChecklistWrite(env.DB,first,"One",noDraft),applyChecklistWrite(env.DB,second,"Two",noDraft)]);
  expect(results.map(r=>r.outcome).sort()).toEqual(["applied","conflict"]);
  const f2=await fixture(), [original]=await rows(f2.orgId,f2.showId);
  await setChecklistEntryCategory({orgId:f2.orgId,entryId:original.id,category:"video",database:env.DB});
  const late=f2.request({kind:"delete",...expected(original)});
  expect((await mutateChecklist({data:late})).outcome).toBe("conflict");
  await setChecklistEntryCategory({orgId:f2.orgId,entryId:original.id,category:"audio",database:env.DB});
  expect((await mutateChecklist({data:late})).outcome).toBe("conflict"); expect(await rows(f2.orgId,f2.showId)).toHaveLength(1);
  // A previously unseen old request must also fail after category A -> B -> A.
  expect((await mutateChecklist({data:f2.request({kind:"delete",...expected(original)})})).outcome).toBe("conflict");
  expect((await rows(f2.orgId,f2.showId))[0].revision).toBe(2);
});
it("scopes edits to the chosen show and organization and rechecks permission on retry",async()=>{
  const f=await fixture(),[row]=await rows(f.orgId,f.showId);
  const wrongShow={...f.request({kind:"delete",...expected(row)}),showId:f.otherShowId};
  expect((await mutateChecklist({data:wrongShow})).outcome).toBe("conflict");
  const outsider=await seedRelayMember(`other-${crypto.randomUUID()}`);
  auth.userId=outsider.userId; await expect(mutateChecklist({data:f.add})).rejects.toThrow();
  auth.userId=f.userId;
  await env.DB.prepare("DELETE FROM member WHERE userId=? AND organizationId=?").bind(f.userId,f.orgId).run();
  await expect(mutateChecklist({data:f.add})).rejects.toThrow(); expect(await rows(f.orgId,f.showId)).toHaveLength(1);
});
it("applies a reviewed draft in one transaction and does not rederive it after acknowledgement",async()=>{
  const f=await fixture(), draft=f.request({kind:"draft",suggestionIds:["one","two","invented"]});
  const resolve=vi.fn(async()=>[{id:"one",label:"Camera",category:"video" as const},{id:"two",label:"House lights",category:"lighting" as const}]);
  await applyChecklistWrite(env.DB,draft,"Fixture",resolve);
  expect(await rows(f.orgId,f.showId)).toHaveLength(3);
  await env.DB.prepare("DELETE FROM checklist_entry WHERE orgId=? AND showId=?").bind(f.orgId,f.showId).run();
  await applyChecklistWrite(env.DB,draft,"Fixture",resolve);
  expect(resolve).toHaveBeenCalledOnce(); expect(await rows(f.orgId,f.showId)).toHaveLength(0);
});
it("rolls back the receipt and all templates/entries when any draft insert fails",async()=>{
  const f=await fixture(),data=f.request({kind:"draft",suggestionIds:["one","two"]});
  await env.DB.prepare("CREATE TRIGGER checklist_fixture_fail BEFORE INSERT ON checklist_entry WHEN NEW.category='lighting' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END").run();
  try {
    await expect(applyChecklistWrite(env.DB,data,"Fixture",async()=>[{id:"one",label:"Camera",category:"video"},{id:"two",label:"House lights",category:"lighting"}])).rejects.toThrow();
    expect(await rows(f.orgId,f.showId)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT id FROM checklist_template WHERE orgId=?").bind(f.orgId).all()).results).toHaveLength(1);
    expect(await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?").bind(f.orgId,`checklist-write:${data.requestId}`).first()).toBeNull();
  } finally { await env.DB.prepare("DROP TRIGGER checklist_fixture_fail").run(); }
});
it("validates captured writes at the boundary",()=>{
  expect(checklistWriteSchema.safeParse({orgId:"org",showId:"show",serviceDate:date,requestId:crypto.randomUUID(),operation:{kind:"add",label:"!!!",category:"audio"}}).success).toBe(false);
});
