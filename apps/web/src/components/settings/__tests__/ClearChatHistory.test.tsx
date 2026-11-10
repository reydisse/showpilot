import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClearChatHistory } from "../ClearChatHistory";
const rpc=vi.hoisted(()=>({clear:vi.fn()}));
vi.mock("@/lib/chat",()=>({clearChatHistory:rpc.clear}));
const clients:QueryClient[]=[];
beforeEach(()=>{vi.useFakeTimers();rpc.clear.mockReset();});
afterEach(()=>{cleanup();for(const client of clients)client.clear();clients.length=0;vi.useRealTimers();});
const settle=(ms=50)=>act(()=>vi.advanceTimersByTimeAsync(ms));
function cache(){const client=new QueryClient();clients.push(client);return client;}
function view(client=cache(),userId="user",orgId="org"){return render(<QueryClientProvider client={client}><ClearChatHistory orgId={orgId} orgName="Fixture Production" userId={userId}/></QueryClientProvider>);}
function confirm(){fireEvent.click(screen.getByRole("button",{name:"Clear chat history"}));fireEvent.change(screen.getByRole("textbox",{name:"Organization name to clear chat"}),{target:{value:"Fixture Production"}});fireEvent.click(screen.getByRole("button",{name:"Permanently clear chat history"}));}
const response=(requestId:string,cleared=true)=>({requestId,cutoff:123,rooms:[{roomId:"production",cleared:true},{roomId:"planning",cleared}]});
it("requires the exact typed name and sends nothing on cancellation",()=>{
  view();fireEvent.click(screen.getByRole("button",{name:"Clear chat history"}));
  expect(screen.getByRole("button",{name:"Permanently clear chat history"}).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"fixture production"}});
  expect(screen.getByRole("button",{name:"Permanently clear chat history"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(rpc.clear).not.toHaveBeenCalled();
});
it("keeps exact recovery intent after the section closes, with account and org isolation",async()=>{
  const client=cache();rpc.clear.mockRejectedValueOnce(new Error("Reply lost"));
  const first=view(client);confirm();await settle();
  const original=rpc.clear.mock.calls[0][0].data;
  first.unmount();const other=view(client,"other");expect(screen.queryByRole("button",{name:"Retry clearing chat history"})).toBeNull();other.unmount();
  const foreign=view(client,"user","other-org");expect(screen.queryByRole("button",{name:"Retry clearing chat history"})).toBeNull();foreign.unmount();
  view(client);rpc.clear.mockResolvedValueOnce(response(original.requestId));
  fireEvent.click(screen.getByRole("button",{name:"Retry clearing chat history"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data).toEqual(original);expect(screen.getByRole("status").textContent).toContain("All 2 rooms confirmed");
});
it("reports incomplete room acknowledgements and retries the original clear",async()=>{
  rpc.clear.mockImplementationOnce(({data})=>Promise.resolve(response(data.requestId,false)));
  view();confirm();await settle();
  expect(screen.getByRole("alert").textContent).toContain("1 of 2 rooms confirmed");
  expect(screen.getByRole("button",{name:"Clear chat history"}).hasAttribute("disabled")).toBe(true);
  const original=rpc.clear.mock.calls[0][0].data;rpc.clear.mockResolvedValueOnce(response(original.requestId));
  fireEvent.click(screen.getByRole("button",{name:"Retry clearing chat history"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data).toEqual(original);
});
it("bounds unconfirmed clears and ignores their late reply after retry",async()=>{
  let release=(_:unknown)=>{};rpc.clear.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  view();confirm();await settle(10_100);
  const original=rpc.clear.mock.calls[0][0].data;
  expect(rpc.clear.mock.calls[0][0].signal.aborted).toBe(true);
  rpc.clear.mockResolvedValueOnce(response(original.requestId));fireEvent.click(screen.getByRole("button",{name:"Retry clearing chat history"}));await settle();
  release(response(original.requestId,false));await settle();expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByRole("status").textContent).toContain("All 2 rooms confirmed");
});
