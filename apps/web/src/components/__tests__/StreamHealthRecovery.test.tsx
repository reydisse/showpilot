import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamHealthWorkspace } from "@/routes/$slug/streaming/health";
import { useLiveInputHealth } from "@/hooks/useLiveInputHealth";
import { StreamHealthPanel } from "@/components/dashboard/tm-operations";
const api = vi.hoisted(() => ({ list:vi.fn(),create:vi.fn(),remove:vi.fn(),resume:vi.fn(),health:vi.fn() }));
vi.mock("@/lib/stream",()=>({getLiveInputs:api.list,createLiveInput:api.create,deleteLiveInput:api.remove,resumeLiveInput:api.resume,getLiveInputStatus:api.health}));
vi.mock("@tanstack/react-router",()=>({createFileRoute:()=>()=>({}),useBlocker:()=>({status:"idle"}),Link:({children}:{children:React.ReactNode})=><span>{children}</span>}));
const row={id:"input",orgId:"fixture",name:"Fixture input",cfInputId:"provider",cfInputUid:"provider",rtmpUrl:"rtmps://fixture.invalid/live",rtmpKey:"fixture-key",srtUrl:"",status:"streaming",hasRtmpKey:true,setupState:"ready" as const,createdAt:new Date()};
const settle=()=>act(async()=>{});
beforeEach(()=>{api.list.mockResolvedValue([row]);api.health.mockResolvedValue({inputId:row.id,status:"streaming",providerStatus:"connected",checkedAt:new Date().toISOString()});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();vi.useRealTimers();});
const mount=()=>render(<StreamHealthWorkspace orgId="fixture" initialInputs={[row]} canManageStreamHealth />);

it("retains a timed-out creation and draft after closing the editor, then retries the exact request",async()=>{
 vi.useFakeTimers();api.create.mockReturnValueOnce(new Promise(()=>{})).mockResolvedValueOnce(row);
 mount();await settle();fireEvent.click(screen.getByRole("button",{name:"Add Input"}));
 fireEvent.change(screen.getByLabelText("Input Name"),{target:{value:"New input"}});
 fireEvent.click(screen.getByRole("button",{name:"Create"}));await settle();
 const sent=api.create.mock.calls[0][0].data;expect(sent.requestId).toEqual(expect.any(String));
 await act(()=>vi.advanceTimersByTimeAsync(10_001));expect(screen.getByRole("alert",{name:"Input change"}).textContent).toContain("not confirmed");
 fireEvent.click(screen.getByRole("button",{name:"Close live input editor"}));await act(()=>vi.advanceTimersByTimeAsync(300));
 fireEvent.click(screen.getByRole("button",{name:"Review input draft"}));expect(screen.getByLabelText("Input Name").getAttribute("value")).toBe("New input");
 fireEvent.click(screen.getByRole("button",{name:"Retry change"}));await settle();
 expect(api.create.mock.calls[1][0].data).toEqual(sent);expect(screen.queryByRole("dialog")).toBeNull();
});

it("retries only the list after acknowledged creation and never repeats the write",async()=>{
 vi.useFakeTimers();api.create.mockResolvedValue(row);mount();await settle();
 fireEvent.click(screen.getByRole("button",{name:"Add Input"}));fireEvent.change(screen.getByLabelText("Input Name"),{target:{value:"New input"}});
 api.list.mockReturnValueOnce(new Promise(()=>{})).mockResolvedValueOnce([row]);
 fireEvent.click(screen.getByRole("button",{name:"Create"}));await settle();await act(()=>vi.advanceTimersByTimeAsync(8_001));
 expect(screen.getByRole("alert",{name:"Input change"}).textContent).toContain("Change saved.");
 fireEvent.click(screen.getByRole("button",{name:"Retry refresh"}));await settle();expect(api.create).toHaveBeenCalledTimes(1);expect(screen.queryByRole("dialog")).toBeNull();
});

it("requires deletion confirmation and retains the same deletion request on Retry",async()=>{
 api.remove.mockRejectedValueOnce(new Error("Lost reply")).mockResolvedValueOnce(undefined);mount();await settle();
 fireEvent.click(screen.getByRole("button",{name:"Delete Fixture input stream input"}));await settle();
 expect(screen.getByRole("dialog").textContent).toContain("Delete Fixture input?");expect(api.remove).not.toHaveBeenCalled();
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Cancel"}));await settle();expect(api.remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Delete Fixture input stream input"}));await settle();
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Delete input"}));await settle();const sent=api.remove.mock.calls[0][0].data;
 fireEvent.click(screen.getByRole("button",{name:"Retry change"}));await settle();expect(api.remove.mock.calls[1][0].data).toEqual(sent);
});

it("offers Resume for setup left pending after reload",async()=>{
 const pending={...row,setupState:"pending" as const};api.list.mockResolvedValue([pending]);api.resume.mockResolvedValue(undefined);
 render(<StreamHealthWorkspace orgId="fixture" initialInputs={[pending]} canManageStreamHealth />);await settle();
 fireEvent.click(screen.getByRole("button",{name:"Resume setup"}));await settle();expect(api.resume.mock.calls[0][0].data).toEqual({orgId:"fixture",inputId:row.id});expect(api.create).not.toHaveBeenCalled();
});

it("bounds health reads, retains last confirmed values and ignores their late replies",async()=>{
 vi.useFakeTimers();mount();await settle();expect(screen.getByText("Streaming")).toBeTruthy();
 let release:(value:unknown)=>void=()=>{};api.health.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
 await act(()=>vi.advanceTimersByTimeAsync(18_001));expect(screen.getByRole("alert",{name:"Retry input health"})).toBeTruthy();expect(screen.queryByText("Streaming")).toBeNull();expect(screen.getByText(/Last confirmed:/)).toBeTruthy();
 api.health.mockResolvedValue({inputId:row.id,status:"idle",providerStatus:"client_disconnect",checkedAt:new Date().toISOString()});fireEvent.click(screen.getByRole("button",{name:"Retry input health"}));await settle();
 await act(async()=>release({inputId:row.id,status:"streaming",providerStatus:"connected",checkedAt:new Date().toISOString()}));expect(screen.getByText("Idle")).toBeTruthy();expect(screen.queryByText("Streaming")).toBeNull();
});

it("never reports cached input state or hardcoded Online as fresh TM telemetry",async()=>{
 vi.useFakeTimers();api.health.mockReturnValueOnce(new Promise(()=>{}));render(<StreamHealthPanel orgId="fixture" slug="fixture" inputs={[row]} destinations={[]} compact />);await settle();
 expect(screen.queryByText("Online")).toBeNull();expect(screen.getByText("0/1")).toBeTruthy();
 await act(()=>vi.advanceTimersByTimeAsync(8_001));expect(screen.getByRole("button",{name:"Retry input health"})).toBeTruthy();expect(screen.queryByText("streaming")).toBeNull();
});

it("reports clipboard failure and lets the operator retry without claiming success",async()=>{
 const writeText=vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});mount();await settle();
 fireEvent.click(screen.getByRole("button",{name:"Copy Stream Key"}));await settle();expect(screen.getByText(/Could not copy Stream Key/)).toBeTruthy();expect(screen.queryByText("Stream Key copied.")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Retry copying Stream Key"}));await settle();expect(screen.getByText("Stream Key copied.")).toBeTruthy();expect(writeText).toHaveBeenLastCalledWith("fixture-key");
});

it("coalesces manual health retries and stops hidden polling until the page is visible",async()=>{
 vi.useFakeTimers();let visibility:DocumentVisibilityState="visible";
 vi.spyOn(document,"visibilityState","get").mockImplementation(()=>visibility);
 api.health.mockReturnValueOnce(new Promise(()=>{}));
 const {result}=renderHook(()=>useLiveInputHealth("fixture",[row]));await settle();
 act(()=>{result.current.retry();result.current.retry();});await settle();expect(api.health).toHaveBeenCalledTimes(1);
 await act(async()=>{visibility="hidden";document.dispatchEvent(new Event("visibilitychange"));});
 expect(api.health.mock.calls[0][0].signal.aborted).toBe(true);await act(()=>vi.advanceTimersByTimeAsync(30_000));expect(api.health).toHaveBeenCalledTimes(1);
 await act(async()=>{visibility="visible";document.dispatchEvent(new Event("visibilitychange"));});expect(api.health).toHaveBeenCalledTimes(2);expect(result.current.value.input?.status).toBe("streaming");
});

it("replaces health ownership when the input IDs change without changing their count",async()=>{
 let release:(value:unknown)=>void=()=>{};api.health.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
 const {result,rerender}=renderHook(({id})=>useLiveInputHealth("fixture",[{id}]),{initialProps:{id:"old"}});await settle();
 api.health.mockResolvedValueOnce({inputId:"new",status:"idle",providerStatus:"idle",checkedAt:new Date().toISOString()});rerender({id:"new"});await settle();
 await act(async()=>release({inputId:"old",status:"streaming",providerStatus:"connected",checkedAt:new Date().toISOString()}));
 expect(result.current.value).not.toHaveProperty("old");expect(result.current.value.new?.status).toBe("idle");
});
