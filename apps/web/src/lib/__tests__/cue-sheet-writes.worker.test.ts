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
import { mutateCueSheet } from "../cue-sheet";
import { applyCueSheetWrite } from "../cue-sheet-writes.server";
import { cueSheetOperationSchema, type CueSheetOperation, type CueSheetWrite } from "../cue-sheet-writes";
const date = "2026-11-06";
async function fixture() {
  const f = await seedRelayMember(`cue-write-${crypto.randomUUID()}`);
  await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(f.orgId).run();
  const showId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Write fixture')").bind(showId,f.orgId,date).run();
  auth.userId=f.userId;
  const request=(operation:CueSheetOperation):CueSheetWrite=>({orgId:f.orgId,requestId:crypto.randomUUID(),operation});
  const column=request({kind:"add-column",label:"Camera",color:"blue"});
  expect((await mutateCueSheet({data:column})).outcome).toBe("applied");
  const note=(text:string,expectedText="")=>request({kind:"note",showId,serviceDate:date,itemId:"fixture-item",columnId:column.requestId,text,expectedText});
  return {...f,showId,columnId:column.requestId,column,request,note};
}
const textOf=async (f: Awaited<ReturnType<typeof fixture>>) => (await env.DB.prepare("SELECT text FROM cue_note WHERE orgId=? AND showId=? AND columnId=?").bind(f.orgId,f.showId,f.columnId).first<{text:string}>())?.text;
const columns=async (orgId:string) => (await env.DB.prepare("SELECT id,label,color,width FROM cue_column WHERE orgId=? ORDER BY sortOrder,createdAt,id").bind(orgId).all<{id:string;label:string;color:string;width:number}>()).results;
it("deduplicates concurrent column creation and rejects a changed retry body",async()=>{
  const f=await fixture(), data=f.request({kind:"add-column",label:"Sound",color:"green"});
  const results=await Promise.all([applyCueSheetWrite(env.DB,data,"Fixture"),applyCueSheetWrite(env.DB,data,"Fixture")]);
  expect(results[0]).toEqual(results[1]); expect((await columns(f.orgId)).filter(c=>c.id===data.requestId)).toHaveLength(1);
  await expect(mutateCueSheet({data:{...data,operation:{kind:"add-column",label:"Different",color:"red"}}})).rejects.toThrow("different cue-sheet change");
});
it("acknowledges an old note receipt without overwriting a later note",async()=>{
  const f=await fixture(), first=f.note("First");
  await mutateCueSheet({data:first}); await mutateCueSheet({data:f.note("Later","First")});
  expect(await mutateCueSheet({data:first})).toEqual({requestId:first.requestId,outcome:"applied",currentText:"Later"});
  expect(await textOf(f)).toBe("Later");
});
it("rejects a late first attempt and keeps its conflict receipt after the old value returns",async()=>{
  const f=await fixture(), late=f.note("Late");
  await mutateCueSheet({data:f.note("Newer")});
  expect((await mutateCueSheet({data:late})).outcome).toBe("conflict");
  await mutateCueSheet({data:f.note("","Newer")});
  expect((await mutateCueSheet({data:late})).outcome).toBe("conflict"); expect(await textOf(f)).toBe("");
});
it("atomically allows only one concurrent edit of the same starting note",async()=>{
  const f=await fixture();
  const results=await Promise.all([applyCueSheetWrite(env.DB,f.note("One"),"Fixture"),applyCueSheetWrite(env.DB,f.note("Two"),"Fixture")]);
  expect(results.map(r=>r.outcome).sort()).toEqual(["applied","conflict"]);
  expect(["One","Two"]).toContain(await textOf(f));
});
it("preserves later rename, color and width changes when old updates are replayed",async()=>{
  const f=await fixture();
  const changes: [CueSheetOperation,CueSheetOperation][] = [
    [{kind:"rename-column",id:f.columnId,before:"Camera",label:"First"},{kind:"rename-column",id:f.columnId,before:"First",label:"Latest"}],
    [{kind:"color-column",id:f.columnId,before:"blue",color:"red"},{kind:"color-column",id:f.columnId,before:"red",color:"green"}],
    [{kind:"resize-column",id:f.columnId,before:160,width:180},{kind:"resize-column",id:f.columnId,before:180,width:220}],
  ];
  for(const [first,next] of changes){const data=f.request(first);await mutateCueSheet({data});await mutateCueSheet({data:f.request(next)});expect((await mutateCueSheet({data})).outcome).toBe("applied");}
  expect(await columns(f.orgId)).toEqual([{id:f.columnId,label:"Latest",color:"green",width:220}]);
  expect((await mutateCueSheet({data:f.request({kind:"rename-column",id:f.columnId,before:"Camera",label:"Stale"})})).outcome).toBe("conflict");
});
it("checks the full column order atomically and never replays an older order",async()=>{
  const f=await fixture(), second=f.request({kind:"add-column",label:"Sound",color:"green"}); await mutateCueSheet({data:second});
  const before=[f.columnId,second.requestId], ids=[...before].reverse();
  const change=f.request({kind:"reorder-columns",before,ids});
  expect((await mutateCueSheet({data:change})).outcome).toBe("applied");
  expect((await mutateCueSheet({data:f.request({kind:"reorder-columns",before,ids})})).outcome).toBe("conflict");
  await mutateCueSheet({data:f.request({kind:"reorder-columns",before:ids,ids:before})});
  await mutateCueSheet({data:change}); expect((await columns(f.orgId)).map(c=>c.id)).toEqual(before);
});
it("deletes all column notes and retains receipts so delayed creates and notes cannot resurrect them",async()=>{
  const f=await fixture(), note=f.note("Saved"); await mutateCueSheet({data:note});
  const remove=f.request({kind:"delete-column",id:f.columnId,label:"Camera"});
  expect((await mutateCueSheet({data:remove})).outcome).toBe("applied");
  await mutateCueSheet({data:f.column}); await mutateCueSheet({data:note}); await mutateCueSheet({data:remove});
  expect((await mutateCueSheet({data:f.note("Late after delete","Saved")})).outcome).toBe("conflict");
  expect(await columns(f.orgId)).toEqual([]); expect(await textOf(f)).toBeUndefined();
});
it("checks current permissions on retry and keeps foreign columns and shows untouched",async()=>{
  const own=await fixture(), other=await fixture(); auth.userId=own.userId;
  expect((await mutateCueSheet({data:own.request({kind:"delete-column",id:other.columnId,label:"Camera"})})).outcome).toBe("conflict");
  const crossShow=own.note("Cross show"); if(crossShow.operation.kind!=="note")throw new Error("Wrong fixture"); crossShow.operation.showId=other.showId;
  expect((await mutateCueSheet({data:crossShow})).outcome).toBe("conflict");
  await expect(mutateCueSheet({data:other.note("Forbidden")})).rejects.toThrow();
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(own.orgId,own.userId).run();
  await expect(mutateCueSheet({data:own.column})).rejects.toThrow(); expect(await columns(other.orgId)).toHaveLength(1);
});
it("rolls back the receipt with a failed write and accepts the same request after recovery",async()=>{
  const f=await fixture(), data=f.note("Retry this"); const trigger=`fail_cue_${data.requestId.replaceAll("-","")}`;
  await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON cue_note WHEN NEW.orgId='${f.orgId}' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`).run();
  try{await expect(mutateCueSheet({data})).rejects.toThrow();}finally{await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();}
  expect(await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?").bind(f.orgId,`cue-sheet-write:${data.requestId}`).first()).toBeNull();
  expect((await mutateCueSheet({data})).outcome).toBe("applied"); expect(await textOf(f)).toBe("Retry this");
});
it("enforces the department limit during concurrent additions and validates order/labels",async()=>{
  const f=await fixture();
  await env.DB.batch(Array.from({length:38},(_,i)=>env.DB.prepare("INSERT INTO cue_column(id,orgId,label,color,sortOrder,width,createdAt,updatedAt) VALUES (?,?,'Fixture','slate',?,160,'2026','2026')").bind(crypto.randomUUID(),f.orgId,i+1)));
  const results=await Promise.all(["Last","Too many"].map(label=>applyCueSheetWrite(env.DB,f.request({kind:"add-column",label,color:"slate"}),"Fixture")));
  expect(results.map(r=>r.outcome).sort()).toEqual(["applied","conflict"]); expect(await columns(f.orgId)).toHaveLength(40);
  expect(cueSheetOperationSchema.safeParse({kind:"add-column",label:"   ",color:"slate"}).success).toBe(false);
  expect(cueSheetOperationSchema.safeParse({kind:"reorder-columns",before:["a","b"],ids:["a","a"]}).success).toBe(false);
});
