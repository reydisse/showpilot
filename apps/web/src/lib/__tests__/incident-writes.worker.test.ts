import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { applyIncidentWrite } from "../incident-writes.server";
import { incidentWriteSchema, type IncidentOperation, type IncidentWrite } from "../incident-writes";
const auth=vi.hoisted(()=>({userId:""}));
const notifications=vi.hoisted(()=>vi.fn());
vi.mock("../incident-notification.server",()=>({scheduleIncidentNotification:notifications}));
vi.mock("../auth",()=>({getAuth:()=>({api:{getSession:async()=>({user:{id:auth.userId,name:"Fixture",email:"fixture@example.test"}})}})}));
vi.mock("@tanstack/react-start/server",()=>({getRequestHeaders:()=>new Headers()}));
vi.mock("@tanstack/react-start",()=>{
  const builder=()=>{let validate=(data:unknown)=>data;const chain={middleware:()=>chain,inputValidator:(fn:typeof validate)=>{validate=fn;return chain;},handler:(fn:(input:{data:unknown})=>unknown)=>(input:{data:unknown})=>fn({data:validate(input.data)}),server:()=>chain};return chain;};
  return {createServerFn:builder,createMiddleware:builder,createServerOnlyFn:<T>(fn:T):T=>fn};
});
import { getIncidentSnapshot, mutateIncident } from "../incidents";
const date="2026-11-06";
async function fixture(){
 const f=await seedRelayMember(`incident-${crypto.randomUUID()}`);auth.userId=f.userId;
 await env.DB.prepare("UPDATE organization SET cloud_enabled=1 WHERE id=?").bind(f.orgId).run();
 const showId=crypto.randomUUID(),otherShowId=crypto.randomUUID();
 for(const id of [showId,otherShowId])await env.DB.prepare("INSERT INTO rundown(id,orgId,serviceDate,name) VALUES (?,?,?,'Incident fixture')").bind(id,f.orgId,date).run();
 const request=(operation:IncidentOperation):IncidentWrite=>({orgId:f.orgId,showId,serviceDate:date,requestId:crypto.randomUUID(),operation});
 const report=request({kind:"report",category:"Audio",severity:"high",description:"Fixture line lost",reportedBy:"Desk"});
 await mutateIncident({data:report});
 const incidentId=`incident-${report.requestId}`;
 const snapshot=()=>getIncidentSnapshot({data:{orgId:f.orgId,showId,serviceDate:date}});
 const comment=(body:string,parentId:string|null=null)=>request({kind:"comment",incidentId,parentId,body});
 return {...f,showId,otherShowId,request,report,incidentId,snapshot,comment,user:{id:f.userId,name:"Fixture"}};
}
it("claims a concurrent report once and returns its receipt after the incident is deleted",async()=>{
 const f=await fixture(),data=f.request({kind:"report",category:"Video",severity:"low",description:"Camera",reportedBy:""});
 const replies=await Promise.all([applyIncidentWrite(env.DB,data,f.user),applyIncidentWrite(env.DB,data,f.user)]);
 expect(replies.map(r=>r.result.outcome)).toEqual(["applied","applied"]);expect(replies.filter(r=>r.notification)).toHaveLength(1);
 let snapshot=await f.snapshot();expect(snapshot.incidents).toHaveLength(2);
 const item=snapshot.incidents.find(i=>i.id===`incident-${data.requestId}`)!;
 const remove=f.request({kind:"delete",id:item.id,snapshot:item.deleteSnapshot});
 await mutateIncident({data:remove});expect((await mutateIncident({data:remove})).outcome).toBe("applied");
 expect((await mutateIncident({data})).outcome).toBe("applied");snapshot=await f.snapshot();expect(snapshot.incidents).toHaveLength(1);
 await expect(mutateIncident({data:{...data,operation:{...data.operation,kind:"report",category:"Audio",severity:"high",description:"Changed body",reportedBy:""}}})).rejects.toThrow("different incident change");
});
it("deduplicates comments and schedules the original notification only once",async()=>{
 const f=await fixture(),comment=f.comment("Confirmed update");notifications.mockClear();
 await mutateIncident({data:comment});await mutateIncident({data:comment});
 const snapshot=await f.snapshot();expect(snapshot.comments).toHaveLength(1);expect(snapshot.comments[0].body).toBe("Confirmed update");expect(notifications).toHaveBeenCalledOnce();
 expect(notifications.mock.calls[0][0]).toMatchObject({once:true,dedupeKey:`incident-write:${comment.requestId}`});
 // A receipt still acknowledges an original reply whose parent was later removed.
 const reply=f.comment("Threaded reply",snapshot.comments[0].id);await mutateIncident({data:reply});
 await env.DB.prepare("DELETE FROM incident_comment WHERE orgId=? AND id=?").bind(f.orgId,snapshot.comments[0].id).run();
 expect((await mutateIncident({data:reply})).outcome).toBe("applied");expect((await f.snapshot()).comments).toHaveLength(0);
});
it("sets a desired reaction once, preserves later removal, and rejects a stale first attempt",async()=>{
 const f=await fixture(),comment=f.comment("Checked cable");await mutateIncident({data:comment});const commentId=`comment-${comment.requestId}`;
 const add=f.request({kind:"reaction",commentId,emoji:"👍",active:true,expectedId:null});
 await mutateIncident({data:add});await mutateIncident({data:add});let snapshot=await f.snapshot();expect(snapshot.reactions).toHaveLength(1);
 const remove=f.request({kind:"reaction",commentId,emoji:"👍",active:false,expectedId:snapshot.reactions[0].id});
 await mutateIncident({data:remove});await mutateIncident({data:add});expect((await f.snapshot()).reactions).toHaveLength(0);
 const latest=f.request({kind:"reaction",commentId,emoji:"👍",active:true,expectedId:null});await mutateIncident({data:latest});
 expect((await mutateIncident({data:f.request(remove.operation)})).outcome).toBe("conflict");expect((await f.snapshot()).reactions).toHaveLength(1);
});
it("rejects deletion after a new discussion or dashboard edit and cleans reactions with the incident",async()=>{
 const f=await fixture(),[initial]=(await f.snapshot()).incidents;
 const remove=f.request({kind:"delete",id:initial.id,snapshot:initial.deleteSnapshot});
 const comment=f.comment("New information");await mutateIncident({data:comment});expect((await mutateIncident({data:remove})).outcome).toBe("conflict");
 let [row]=(await f.snapshot()).incidents;await env.DB.prepare("UPDATE incident SET assignedTo=?,assignedName='New owner' WHERE orgId=? AND id=?").bind(f.userId,f.orgId,row.id).run();
 expect((await mutateIncident({data:f.request({kind:"delete",id:row.id,snapshot:row.deleteSnapshot})})).outcome).toBe("conflict");
 await mutateIncident({data:f.request({kind:"reaction",commentId:`comment-${comment.requestId}`,emoji:"👍",active:true,expectedId:null})});
 [row]=(await f.snapshot()).incidents;await mutateIncident({data:f.request({kind:"delete",id:row.id,snapshot:row.deleteSnapshot})});
 expect((await f.snapshot()).incidents).toHaveLength(0);expect((await f.snapshot()).comments).toHaveLength(0);
 expect((await env.DB.prepare("SELECT id FROM content_reaction WHERE orgId=?").bind(f.orgId).all()).results).toHaveLength(0);
});
it("rejects another show, another organization and revoked membership on retry",async()=>{
 const f=await fixture(),comment=f.comment("Wrong show");expect((await mutateIncident({data:{...comment,showId:f.otherShowId}})).outcome).toBe("conflict");
 const other=await seedRelayMember(`other-${crypto.randomUUID()}`);auth.userId=other.userId;
 await expect(mutateIncident({data:f.report})).rejects.toThrow();await expect(f.snapshot()).rejects.toThrow();
 auth.userId=f.userId;await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.userId).run();await expect(mutateIncident({data:f.report})).rejects.toThrow();
});
it("reads more than 200 comments/reactions as one scoped snapshot without an IN-list limit",async()=>{
 const f=await fixture();
 for(let start=0;start<210;start+=30){const statements=[];for(let n=start;n<start+30;n++){
  const id=`bulk-${crypto.randomUUID()}`;statements.push(env.DB.prepare("INSERT INTO incident_comment(id,orgId,incidentId,userId,authorName,body) VALUES (?,?,?,?,'Fixture','Update')").bind(id,f.orgId,f.incidentId,f.userId));
  statements.push(env.DB.prepare("INSERT INTO content_reaction(id,orgId,targetType,targetId,userId,authorName,emoji) VALUES (?,?,'incident-comment',?,?,'Fixture','👍')").bind(crypto.randomUUID(),f.orgId,id,f.userId));
 }await env.DB.batch(statements);}
 const snapshot=await f.snapshot();expect(snapshot.comments).toHaveLength(210);expect(snapshot.reactions).toHaveLength(210);expect(snapshot.comments[0].createdAt).toMatch(/Z$/);
 const other=await getIncidentSnapshot({data:{orgId:f.orgId,showId:f.otherShowId,serviceDate:date}});expect(other.comments).toEqual([]);expect(other.reactions).toEqual([]);
});
it("rolls back the receipt if the actual write fails",async()=>{
 const f=await fixture(),data=f.comment("Failure");
 await env.DB.prepare("CREATE TRIGGER incident_fixture_failure BEFORE INSERT ON incident_comment BEGIN SELECT RAISE(ABORT,'fixture reject'); END").run();
 try{await expect(mutateIncident({data})).rejects.toThrow();expect(await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?").bind(f.orgId,`incident-write:${data.requestId}`).first()).toBeNull();}
 finally{await env.DB.prepare("DROP TRIGGER incident_fixture_failure").run();}
 expect((await mutateIncident({data})).outcome).toBe("applied");
});
it("retains comment moderation and rejects malformed reaction intent",()=>{
 const input={orgId:"org",showId:"show",serviceDate:date,requestId:crypto.randomUUID()};
 expect(incidentWriteSchema.safeParse({...input,operation:{kind:"comment",incidentId:"incident",parentId:null,body:"I will hurt you"}}).success).toBe(false);
 expect(incidentWriteSchema.safeParse({...input,operation:{kind:"reaction",commentId:"comment",emoji:"not emoji",active:true,expectedId:null}}).success).toBe(false);
});
it("preserves date-only mobile incident discussion without crossing into a show or another date",async()=>{
 const f=await fixture(),legacyId=crypto.randomUUID(),laterId=crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO incident(id,orgId,category,severity,description,reportedBy,serviceDate) VALUES (?,?,'audio','high','Date-only incident','Mobile',?)").bind(legacyId,f.orgId,date),
  env.DB.prepare("INSERT INTO incident(id,orgId,category,severity,description,reportedBy,serviceDate) VALUES (?,?,'audio','high','Other date','Mobile','2026-11-07')").bind(laterId,f.orgId),
 ]);
 const snapshot=()=>getIncidentSnapshot({data:{orgId:f.orgId,showId:null,serviceDate:date}});
 expect((await snapshot()).incidents.map(row=>row.id)).toEqual([legacyId]);
 const comment={...f.request({kind:"comment",incidentId:legacyId,parentId:null,body:"Follow up on mobile report"}),showId:null};
 await mutateIncident({data:comment});await mutateIncident({data:comment});expect((await snapshot()).comments).toHaveLength(1);
 const reaction={...f.request({kind:"reaction",commentId:`comment-${comment.requestId}`,emoji:"👍",active:true,expectedId:null}),showId:null};
 await mutateIncident({data:reaction});await mutateIncident({data:reaction});expect((await snapshot()).reactions).toHaveLength(1);
 expect((await mutateIncident({data:{...f.comment("Must not cross into a show"),showId:null}})).outcome).toBe("conflict");
 expect((await mutateIncident({data:{...comment,requestId:crypto.randomUUID(),serviceDate:"2026-11-07"}})).outcome).toBe("conflict");
 const [row]=(await snapshot()).incidents;
 const remove={...f.request({kind:"delete",id:legacyId,snapshot:row.deleteSnapshot}),showId:null};
 expect((await mutateIncident({data:remove})).outcome).toBe("applied");expect((await mutateIncident({data:comment})).outcome).toBe("applied");
 expect((await snapshot()).incidents).toHaveLength(0);expect((await snapshot()).comments).toHaveLength(0);expect((await snapshot()).reactions).toHaveLength(0);
 expect((await f.snapshot()).incidents).toHaveLength(1);
 expect(await env.DB.prepare("SELECT id FROM incident WHERE orgId=? AND id=?").bind(f.orgId,laterId).first()).not.toBeNull();
 expect(incidentWriteSchema.safeParse({...f.report,showId:null}).success).toBe(false);
});
