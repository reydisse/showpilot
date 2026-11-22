import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncidentDetailWorkspace } from "./$slug/production/incident.$incidentId";
const api=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),navigate:vi.fn()}));
vi.mock("@/lib/incidents",()=>({getIncidentDetail:api.read,mutateIncident:api.write}));
vi.mock("@/lib/incident-history",()=>({getIncidentHistory:vi.fn()}));
vi.mock("@tanstack/react-router",async original=>({...await original<typeof import("@tanstack/react-router")>(),useNavigate:()=>api.navigate,useBlocker:()=>({status:"idle"}),Link:({children}:{children:React.ReactNode})=><a>{children}</a>}));
const incident={id:"incident",showId:"show",serviceDate:"2026-11-06",showName:"Traditional Service",category:"Audio",severity:"high",description:"Line lost\nThe pastor's lapel cut out twice.",reportedBy:"Desk",timestamp:"2026-11-06T15:00:00Z",status:"open",assignedTo:null,assignedName:"",acknowledgedAt:null,resolutionNote:"",deleteSnapshot:"snapshot"};
const comment={id:"comment",incidentId:"incident",userId:"viewer",authorName:"Fixture",body:"Checking cable",parentId:null,createdAt:"2026-11-06T15:01:00Z"};
const detail={incident,comments:[comment],reactions:[],responders:[{userId:"viewer",name:"Fixture",role:"owner"},{userId:"tech",name:"Nana Owusu",role:"td"}],canManage:true,viewerId:"viewer"};
const initial={detail,orgId:"org",order:["newer","incident","older"],total:3} satisfies ComponentProps<typeof IncidentDetailWorkspace>["initial"];
const tick=async(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();api.read.mockResolvedValue(detail);api.write.mockImplementation(async({data})=>({requestId:data.requestId,outcome:"applied"}));});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("shows the title, details and position in history",async()=>{
 render(<IncidentDetailWorkspace initial={initial} slug="org" incidentId="incident"/>);await tick();
 expect(screen.getByRole("heading",{name:"Line lost"})).toBeTruthy();expect(screen.getByText("The pastor's lapel cut out twice.")).toBeTruthy();
 expect(screen.getByText("No resolution note yet")).toBeTruthy();expect(document.body.textContent).toContain("2 of 3");
});
it("keeps a newer comment draft while retrying the original comment",async()=>{
 render(<IncidentDetailWorkspace initial={initial} slug="org" incidentId="incident"/>);await tick();
 fireEvent.change(screen.getByLabelText("Add a comment"),{target:{value:"First update"}});api.write.mockRejectedValueOnce(new Error("lost"));fireEvent.click(screen.getByRole("button",{name:"Comment"}));await tick();
 fireEvent.change(screen.getByLabelText("Add a comment"),{target:{value:"New draft while awaiting confirmation"}});fireEvent.click(screen.getByRole("button",{name:"Retry incident save"}));await tick();
 expect(api.write.mock.calls[1][0].data).toEqual(api.write.mock.calls[0][0].data);expect(screen.getByLabelText("Add a comment")).toHaveProperty("value","New draft while awaiting confirmation");
});
it("captures desired reaction state and does not invert it when a response is lost",async()=>{
 const reacted={...detail,reactions:[{id:"reaction",targetId:"comment",userId:"viewer",authorName:"Fixture",emoji:"👍",createdAt:"2026-11-06T15:02:00Z"}]};api.read.mockResolvedValue(reacted);
 render(<IncidentDetailWorkspace initial={{...initial,detail:reacted}} slug="org" incidentId="incident"/>);await tick();
 api.write.mockRejectedValueOnce(new Error("lost"));fireEvent.click(screen.getByRole("button",{name:"React 👍"}));await tick();
 expect(api.write.mock.calls[0][0].data.operation).toEqual({kind:"reaction",commentId:"comment",emoji:"👍",active:false,expectedId:"reaction"});
 fireEvent.click(screen.getByRole("button",{name:"Retry incident save"}));await tick();expect(api.write.mock.calls[1][0].data).toEqual(api.write.mock.calls[0][0].data);
});
it("requires review after a stale delete and keeps moderated text editable without a write",async()=>{
 render(<IncidentDetailWorkspace initial={initial} slug="org" incidentId="incident"/>);await tick();
 fireEvent.change(screen.getByLabelText("Add a comment"),{target:{value:"I will hurt you"}});expect(screen.getByRole("button",{name:"Comment"})).toHaveProperty("disabled",true);expect(screen.getByRole("alert").textContent).toContain("threat");
 fireEvent.change(screen.getByLabelText("Add a comment"),{target:{value:"Checking safely"}});expect(screen.getByRole("button",{name:"Comment"})).toHaveProperty("disabled",false);
 api.write.mockImplementationOnce(async({data})=>({requestId:data.requestId,outcome:"conflict"}));
 fireEvent.click(screen.getByRole("button",{name:"Delete incident: Line lost"}));await tick();fireEvent.click(screen.getByRole("button",{name:"Delete incident"}));await tick();
 expect(api.write.mock.calls[0][0].data.operation).toEqual({kind:"delete",id:"incident",snapshot:"snapshot"});expect(api.navigate).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Got it"}));await tick();expect(api.write).toHaveBeenCalledOnce();expect(screen.getByRole("heading",{name:"Line lost"})).toBeTruthy();
});
it("edits details with the current revision and shows the change at once",async()=>{
 render(<IncidentDetailWorkspace initial={initial} slug="org" incidentId="incident"/>);await tick();
 let finish:(value:unknown)=>void=()=>{};api.write.mockImplementationOnce(({data})=>new Promise(resolve=>{finish=()=>resolve({requestId:data.requestId,outcome:"applied"});}));
 fireEvent.change(screen.getByLabelText("Status"),{target:{value:"resolved"}});await tick();
 expect(api.write.mock.calls[0][0].data.operation).toEqual({kind:"update",id:"incident",snapshot:"snapshot",changes:{status:"resolved"}});
 expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);await act(async()=>finish(null));
 fireEvent.click(screen.getByRole("button",{name:"Add note"}));fireEvent.change(screen.getByLabelText("Resolution note"),{target:{value:"Swapped the lapel pack."}});fireEvent.click(screen.getByRole("button",{name:"Save note"}));await tick();
 expect(api.write.mock.calls[1][0].data.operation).toMatchObject({kind:"update",changes:{resolutionNote:"Swapped the lapel pack."}});
});
it("keeps date-only incident discussion working and hides editing from reporters",async()=>{
 const reporter={...detail,incident:{...incident,showId:null},canManage:false,responders:[]};api.read.mockResolvedValue(reporter);
 render(<IncidentDetailWorkspace initial={{...initial,detail:reporter}} slug="org" incidentId="incident"/>);await tick();
 expect(screen.queryByLabelText("Status")).toBeNull();expect(screen.queryByRole("button",{name:/^Delete incident:/})).toBeNull();expect(screen.queryByRole("button",{name:"Add note"})).toBeNull();
 fireEvent.change(screen.getByLabelText("Add a comment"),{target:{value:"Date-only follow-up"}});fireEvent.click(screen.getByRole("button",{name:"Comment"}));await tick();
 expect(api.write.mock.calls[0][0].data).toMatchObject({showId:null,serviceDate:"2026-11-06",operation:{kind:"comment",body:"Date-only follow-up"}});
});
it("says so plainly when the incident is gone",async()=>{
 const gone={...detail,incident:null};api.read.mockResolvedValue(gone);
 render(<IncidentDetailWorkspace initial={{...initial,detail:gone} as unknown as ComponentProps<typeof IncidentDetailWorkspace>["initial"]} slug="org" incidentId="incident"/>);await tick();
 expect(screen.getByText("This incident is no longer here")).toBeTruthy();
});
