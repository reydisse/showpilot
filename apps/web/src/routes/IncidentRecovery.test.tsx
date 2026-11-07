import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncidentsWorkspace } from "./$slug/production/incidents";
const api=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),refresh:(_signal:AbortSignal):Promise<void>=>Promise.resolve(),publish:vi.fn()}));
vi.mock("@/lib/incidents",()=>({getIncidentSnapshot:api.read,mutateIncident:api.write}));
vi.mock("@/lib/settings",()=>({getOrgSettings:vi.fn()}));
vi.mock("@/lib/rundown",()=>({getRundownOpeningDate:vi.fn()}));
vi.mock("@/lib/incident-history",()=>({getIncidentHistory:vi.fn()}));
vi.mock("@/hooks/useCueSheetSync",()=>({useCueSheetSync:(options:{onRefresh:(signal:AbortSignal)=>Promise<void>})=>{api.refresh=options.onRefresh;return {publish:api.publish,syncError:null,syncErrorAt:null,status:"connected",retrySync:vi.fn()};}}));
vi.mock("@tanstack/react-router",async original=>({...await original<typeof import("@tanstack/react-router")>(),useBlocker:()=>({status:"idle"}),Link:({children}:{children:React.ReactNode})=><a>{children}</a>}));
vi.mock("@/components/show-switcher-menu",()=>({ShowSwitcherMenu:({onSelect}:{onSelect:(show:{id:string;serviceDate:string})=>void})=><button onClick={()=>onSelect({id:"other-show",serviceDate:"2026-11-06"})}>Other show</button>}));
const incident={id:"incident",category:"Audio",severity:"high",description:"Line lost",reportedBy:"Desk",timestamp:"2026-11-06T15:00:00Z",status:"open",assignedTo:null,assignedName:"",acknowledgedAt:null,deleteSnapshot:"snapshot"};
const comment={id:"comment",incidentId:"incident",userId:"viewer",authorName:"Fixture",body:"Checking cable",parentId:null,createdAt:"2026-11-06T15:01:00Z"};
const snapshot={incidents:[incident],comments:[comment],reactions:[],viewerId:"viewer"};
const initial={snapshot,recentHistory:{incidents:[],total:0,page:1,pageSize:10,categories:[]},orgId:"org",role:"owner",grantedPermissions:[],orgTimezone:"UTC",initialServiceDate:"2026-11-06",initialShowId:"show",shows:[]} satisfies ComponentProps<typeof IncidentsWorkspace>["initial"];
const tick=async(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();api.read.mockResolvedValue(snapshot);api.write.mockImplementation(async({data})=>({requestId:data.requestId,outcome:"applied"}));});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("coalesces relay hydration and the page read and never confirms a timed-out snapshot",async()=>{
 api.read.mockImplementationOnce(()=>new Promise(()=>{}));render(<IncidentsWorkspace initial={initial} slug="org"/>);await tick();
 const relay=api.refresh(new AbortController().signal);const failure=expect(relay).rejects.toThrow("not confirmed");await tick(8000);await failure;
 expect(api.read).toHaveBeenCalledOnce();expect(screen.getByRole("alert",{name:"Retry incidents"}).querySelector("time")).not.toBeNull();expect(screen.getByText("Line lost")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry incidents"}));await tick();expect(api.write).not.toHaveBeenCalled();
});
it("hides the old discussion during another show's load and never combines loading with empty",async()=>{
 render(<IncidentsWorkspace initial={initial} slug="org"/>);await tick();let finish:(value:unknown)=>void=()=>{};
 api.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));fireEvent.click(screen.getByRole("button",{name:"Other show"}));await tick();
 expect(screen.queryByText("Line lost")).toBeNull();expect(screen.queryByText("No incidents for this date")).toBeNull();expect(screen.getByText(/Loading incidents for/)).toBeTruthy();
 await tick(8000);expect(screen.queryByText(/Loading incidents for/)).toBeNull();expect(screen.queryByText("No incidents for this date")).toBeNull();
 await act(async()=>finish(snapshot));expect(screen.queryByText("Line lost")).toBeNull();
 api.read.mockResolvedValue({...snapshot,incidents:[],comments:[]});fireEvent.click(screen.getByRole("button",{name:"Retry incidents"}));await tick();expect(screen.getByText("No incidents for this date")).toBeTruthy();
});
it("keeps a report through response loss and separates its acknowledgement from a failed refresh",async()=>{
 render(<IncidentsWorkspace initial={initial} slug="org"/>);await tick();fireEvent.click(screen.getByRole("button",{name:"Report"}));
 fireEvent.change(screen.getByLabelText("What happened?"),{target:{value:"Camera signal lost"}});api.write.mockRejectedValueOnce(new Error("lost"));fireEvent.click(screen.getByRole("button",{name:"Submit report"}));await tick();
 expect(screen.getByLabelText("What happened?")).toHaveProperty("value","Camera signal lost");
 api.read.mockImplementationOnce(()=>new Promise(()=>{}));fireEvent.click(screen.getByRole("button",{name:"Retry incident save"}));await tick();
 expect(screen.queryByRole("dialog")).toBeNull();expect(screen.getByRole("status").textContent).toBe("Change saved.");await tick(8000);
 expect(api.write.mock.calls[0][0].data).toEqual(api.write.mock.calls[1][0].data);
 fireEvent.click(screen.getByRole("button",{name:"Retry incidents"}));await tick();expect(api.write).toHaveBeenCalledTimes(2);
});
it("keeps a newer comment draft while retrying the original comment",async()=>{
 render(<IncidentsWorkspace initial={initial} slug="org" focusedIncidentId="incident"/>);await tick();
 fireEvent.change(screen.getByLabelText("Update for Line lost"),{target:{value:"First update"}});api.write.mockRejectedValueOnce(new Error("lost"));fireEvent.click(screen.getByRole("button",{name:"Post comment"}));await tick();
 fireEvent.change(screen.getByLabelText("Update for Line lost"),{target:{value:"New draft while awaiting confirmation"}});fireEvent.click(screen.getByRole("button",{name:"Retry incident save"}));await tick();
 expect(api.write.mock.calls[1][0].data).toEqual(api.write.mock.calls[0][0].data);expect(screen.getByLabelText("Update for Line lost")).toHaveProperty("value","New draft while awaiting confirmation");
});
it("captures desired reaction state and does not invert it when a response is lost",async()=>{
 const reacted={...snapshot,reactions:[{id:"reaction",targetId:"comment",userId:"viewer",authorName:"Fixture",emoji:"👍",createdAt:"2026-11-06T15:02:00Z"}]};api.read.mockResolvedValue(reacted);
 render(<IncidentsWorkspace initial={{...initial,snapshot:reacted}} slug="org" focusedIncidentId="incident"/>);await tick();
 api.write.mockRejectedValueOnce(new Error("lost"));fireEvent.click(screen.getByRole("button",{name:"React 👍"}));await tick();
 expect(api.write.mock.calls[0][0].data.operation).toEqual({kind:"reaction",commentId:"comment",emoji:"👍",active:false,expectedId:"reaction"});
 fireEvent.click(screen.getByRole("button",{name:"Retry incident save"}));await tick();expect(api.write.mock.calls[1][0].data).toEqual(api.write.mock.calls[0][0].data);
});
it("requires review after a stale delete and keeps moderated text editable without an uncertain write",async()=>{
 render(<IncidentsWorkspace initial={initial} slug="org" focusedIncidentId="incident"/>);await tick();
 fireEvent.change(screen.getByLabelText("Update for Line lost"),{target:{value:"I will hurt you"}});expect(screen.getByRole("button",{name:"Post comment"})).toHaveProperty("disabled",true);expect(screen.getByRole("alert").textContent).toContain("threat");
 fireEvent.change(screen.getByLabelText("Update for Line lost"),{target:{value:"Checking safely"}});expect(screen.getByRole("button",{name:"Post comment"})).toHaveProperty("disabled",false);
 api.write.mockImplementationOnce(async({data})=>({requestId:data.requestId,outcome:"conflict"}));
 fireEvent.click(screen.getByRole("button",{name:"Delete incident: Line lost"}));fireEvent.click(screen.getByRole("button",{name:"Delete"}));await tick();
 expect(api.write.mock.calls[0][0].data.operation).toEqual({kind:"delete",id:"incident",snapshot:"snapshot"});
 fireEvent.click(screen.getByRole("button",{name:"I reviewed the incident log"}));await tick();expect(api.write).toHaveBeenCalledOnce();expect(screen.getByText("Line lost")).toBeTruthy();
});
it("keeps existing date-only incident discussion editable without offering a new show report",async()=>{
 render(<IncidentsWorkspace initial={{...initial,initialShowId:null}} slug="org" focusedIncidentId="incident"/>);await tick();
 expect(screen.queryByRole("button",{name:"Report"})).toBeNull();
 fireEvent.change(screen.getByLabelText("Update for Line lost"),{target:{value:"Date-only follow-up"}});
 expect(screen.getByRole("button",{name:"Post comment"})).toHaveProperty("disabled",false);
 fireEvent.click(screen.getByRole("button",{name:"Post comment"}));await tick();
 expect(api.write.mock.calls[0][0].data).toMatchObject({showId:null,serviceDate:"2026-11-06",operation:{kind:"comment",body:"Date-only follow-up"}});
 expect(screen.getByRole("button",{name:"Delete incident: Line lost"})).toHaveProperty("disabled",false);
});
