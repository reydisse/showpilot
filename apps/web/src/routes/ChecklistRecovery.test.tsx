import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChecklistWorkspace } from "./$slug/production/checklist";
const api=vi.hoisted(()=>({entries:vi.fn(),opening:vi.fn(),write:vi.fn(),draft:vi.fn()}));
vi.mock("@/lib/data",()=>({getChecklistEntries:api.entries,getSmartChecklistDraft:api.draft,mutateChecklist:api.write}));
vi.mock("@/lib/rundown",()=>({getRundownOpeningDate:api.opening}));
vi.mock("@/lib/settings",()=>({getOrgSettings:vi.fn()}));
vi.mock("@tanstack/react-router",async original=>({...await original<typeof import("@tanstack/react-router")>(),useBlocker:()=>({status:"idle"})}));
vi.mock("@/components/show-switcher-menu",()=>({ShowSwitcherMenu:({onSelect}:{onSelect:(show:{id:string;serviceDate:string})=>void})=><button onClick={()=>onSelect({id:"other-show",serviceDate:"2026-11-06"})}>Other show</button>}));
const row={id:"entry",orgId:"org",showId:"show",serviceDate:"2026-11-06",templateId:"template",category:"audio",checked:false,checkedAt:null,checkedBy:null,revision:0,template:{id:"template",orgId:"org",label:"Line check",category:"audio",sortOrder:0,createdAt:new Date()}};
const initial={entries:[row],serviceDate:"2026-11-06",showId:"show",shows:[],orgId:"org",role:"owner",grantedPermissions:[],orgTimezone:"America/Toronto"} satisfies ComponentProps<typeof ChecklistWorkspace>["initial"];
const tick=async(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();api.entries.mockResolvedValue([row]);api.opening.mockImplementation(async({data})=>({showId:data.showId}));api.draft.mockResolvedValue([]);api.write.mockImplementation(async({data})=>({requestId:data.requestId,outcome:"applied"}));});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("bounds reads and retains confirmed entries without allowing a stale write",async()=>{
  let late:(value:unknown)=>void=()=>{};api.entries.mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));
  render(<ChecklistWorkspace initial={initial}/>);await tick(8000);
  expect(screen.getByText("Line check")).toBeTruthy();expect(screen.queryByText("Loading checklist...")).toBeNull();
  expect(screen.getByRole("alert",{name:"Retry checklist"}).querySelector("time")).not.toBeNull();
  expect(screen.getByRole("button",{name:"Mark complete: Line check"})).toHaveProperty("disabled",true);
  await act(async()=>late([]));expect(screen.getByText("Line check")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Retry checklist"}));await tick();
  expect(screen.getByRole("button",{name:"Mark complete: Line check"})).toHaveProperty("disabled",false);expect(api.write).not.toHaveBeenCalled();
});
it("hides old show entries during a new read, rejects late replies and never shows a failed read as empty",async()=>{
  render(<ChecklistWorkspace initial={initial}/>);await tick();
  let late:(value:unknown)=>void=()=>{};api.entries.mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));
  fireEvent.click(screen.getByRole("button",{name:"Other show"}));await tick();
  expect(screen.queryByText("Line check")).toBeNull();expect(screen.getByText("Loading checklist...")).toBeTruthy();
  expect(screen.queryByText("No checklist items for this date")).toBeNull();
  await tick(8000);expect(screen.queryByText("Loading checklist...")).toBeNull();expect(screen.queryByText("No checklist items for this date")).toBeNull();
  await act(async()=>late([row]));expect(screen.queryByText("Line check")).toBeNull();
  api.entries.mockResolvedValue([]);fireEvent.click(screen.getByRole("button",{name:"Retry checklist"}));await tick();expect(screen.getByText("No checklist items for this date")).toBeTruthy();
});
it("acknowledges a save independently of the following refresh and never replays it on read Retry",async()=>{
  render(<ChecklistWorkspace initial={initial}/>);await tick();
  fireEvent.change(screen.getByLabelText("Checklist item"),{target:{value:"Camera"}});
  api.entries.mockImplementationOnce(()=>new Promise(()=>{}));
  fireEvent.click(screen.getByRole("button",{name:"Add checklist item"}));await tick();
  expect(screen.getByLabelText("Checklist item")).toHaveProperty("value","");expect(screen.getByRole("status").textContent).toContain("Change saved");
  await tick(8000);fireEvent.click(screen.getByRole("button",{name:"Retry checklist"}));await tick();expect(api.write).toHaveBeenCalledOnce();
});
it("retains add text and the original request after a lost save response",async()=>{
  render(<ChecklistWorkspace initial={initial}/>);await tick();
  fireEvent.change(screen.getByLabelText("Checklist item"),{target:{value:"Camera"}});api.write.mockRejectedValueOnce(new Error("lost"));
  fireEvent.click(screen.getByRole("button",{name:"Add checklist item"}));await tick();
  expect(screen.getByLabelText("Checklist item")).toHaveProperty("value","Camera");
  expect(screen.getByRole("alert",{name:"Retry checklist save"}).querySelector("time")).not.toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Retry checklist save"}));await tick();
  expect(api.write.mock.calls[1][0].data).toEqual(api.write.mock.calls[0][0].data);expect(screen.getByLabelText("Checklist item")).toHaveProperty("value","");
});
it("does not present an unconfirmed category as saved and requires review after a conflict",async()=>{
  render(<ChecklistWorkspace initial={initial}/>);await tick();
  api.write.mockImplementationOnce(async({data})=>({requestId:data.requestId,outcome:"conflict"}));
  fireEvent.change(screen.getByLabelText("Department for Line check"),{target:{value:"video"}});await tick();
  expect(screen.getByLabelText("Department for Line check")).toHaveProperty("value","audio");
  fireEvent.click(screen.getByRole("button",{name:"I reviewed the refreshed checklist"}));await tick();
  expect(api.write).toHaveBeenCalledOnce();expect(screen.getByRole("button",{name:"Mark complete: Line check"})).toHaveProperty("disabled",false);
});
it("bounds read-only suggestions and does not apply anything on Retry",async()=>{
  render(<ChecklistWorkspace initial={initial}/>);await tick();api.draft.mockImplementationOnce(()=>new Promise(()=>{}));
  fireEvent.click(screen.getByRole("button",{name:"Generate checklist from rundown"}));await tick(8000);
  expect(screen.queryByText("Analyzing rundown cues…")).toBeNull();expect(screen.queryByText("No new checks found")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Retry checklist suggestions"}));await tick();expect(screen.getByText("No new checks found")).toBeTruthy();expect(api.write).not.toHaveBeenCalled();
});
