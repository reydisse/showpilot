import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResetSavedGraphics } from "../ResetSavedGraphics";
const rpc=vi.hoisted(()=>({clear:vi.fn()}));
vi.mock("@/lib/lowerthirds",()=>({resetLowerThirdLibrary:rpc.clear}));
const clients:QueryClient[]=[];
beforeEach(()=>{vi.useFakeTimers();rpc.clear.mockReset();});
afterEach(()=>{cleanup();for(const client of clients)client.clear();clients.length=0;vi.useRealTimers();});
const settle=(ms=50)=>act(()=>vi.advanceTimersByTimeAsync(ms));
function cache(){const client=new QueryClient();clients.push(client);return client;}
function view(client=cache(),userId="user",orgId="org"){return render(<QueryClientProvider client={client}><ResetSavedGraphics orgId={orgId} orgName="Fixture Production" userId={userId}/></QueryClientProvider>);}
function confirm(){fireEvent.click(screen.getByRole("button",{name:"Reset saved graphics"}));fireEvent.change(screen.getByRole("textbox",{name:"Organization name to reset graphics"}),{target:{value:"Fixture Production"}});fireEvent.click(screen.getByRole("button",{name:"Permanently delete saved graphics"}));}
const response=(requestId:string)=>({requestId,deletedCount:2});
it("requires the exact typed name and sends nothing on cancellation",()=>{
  view();fireEvent.click(screen.getByRole("button",{name:"Reset saved graphics"}));
  expect(screen.getByRole("button",{name:"Permanently delete saved graphics"}).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"fixture production"}});
  expect(screen.getByRole("button",{name:"Permanently delete saved graphics"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(rpc.clear).not.toHaveBeenCalled();
});
it("keeps exact recovery intent after the section closes, with account and org isolation",async()=>{
  const client=cache();rpc.clear.mockRejectedValueOnce(new Error("Reply lost"));
  const first=view(client);confirm();await settle();
  const original=rpc.clear.mock.calls[0][0].data;
  first.unmount();const other=view(client,"other");expect(screen.queryByRole("button",{name:"Retry graphics reset"})).toBeNull();other.unmount();
  const foreign=view(client,"user","other-org");expect(screen.queryByRole("button",{name:"Retry graphics reset"})).toBeNull();foreign.unmount();
  view(client);rpc.clear.mockResolvedValueOnce(response(original.requestId));
  fireEvent.click(screen.getByRole("button",{name:"Retry graphics reset"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data).toEqual(original);expect(screen.getByRole("status").textContent).toContain("2 saved graphics were deleted.");
});
it("bounds unconfirmed clears and ignores their late reply after retry",async()=>{
  let release=(_:unknown)=>{};rpc.clear.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  view();confirm();await settle(10_100);
  const original=rpc.clear.mock.calls[0][0].data;
  expect(rpc.clear.mock.calls[0][0].signal.aborted).toBe(true);
  rpc.clear.mockResolvedValueOnce(response(original.requestId));fireEvent.click(screen.getByRole("button",{name:"Retry graphics reset"}));await settle();
  release(response(original.requestId));await settle();expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByRole("status").textContent).toContain("2 saved graphics were deleted.");
});

it("requires a new typed confirmation and request for a later reset",async()=>{
  rpc.clear.mockImplementation(({data})=>Promise.resolve(response(data.requestId)));
  view();confirm();await settle();
  const first=rpc.clear.mock.calls[0][0].data;
  fireEvent.click(screen.getByRole("button",{name:"Reset saved graphics"}));
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button",{name:"Permanently delete saved graphics"}).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"Fixture Production"}});
  fireEvent.click(screen.getByRole("button",{name:"Permanently delete saved graphics"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data.requestId).not.toBe(first.requestId);
});
