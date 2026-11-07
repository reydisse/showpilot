import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeleteOrganization } from "../DeleteOrganization";
const rpc=vi.hoisted(()=>({clear:vi.fn(),navigate:vi.fn()}));
vi.mock("@/lib/org-deletion",()=>({deleteOrganization:rpc.clear}));
const clients:QueryClient[]=[];
beforeEach(()=>{vi.useFakeTimers();rpc.clear.mockReset();rpc.navigate.mockReset();});
afterEach(()=>{cleanup();for(const client of clients)client.clear();clients.length=0;vi.useRealTimers();});
const settle=(ms=50)=>act(()=>vi.advanceTimersByTimeAsync(ms));
function cache(){const client=new QueryClient();clients.push(client);return client;}
function view(client=cache(),userId="user",orgId="org"){return render(<QueryClientProvider client={client}><DeleteOrganization orgId={orgId} orgName="Fixture Production" userId={userId} onDeleted={rpc.navigate}/></QueryClientProvider>);}
function confirm(){fireEvent.click(screen.getByRole("button",{name:"Delete organization"}));fireEvent.change(screen.getByRole("textbox",{name:"Organization name to delete organization"}),{target:{value:"Fixture Production"}});fireEvent.click(screen.getByRole("button",{name:"Permanently delete organization"}));}
const response=()=>({alreadyDeleted:true});
it("requires the exact typed name and sends nothing on cancellation",()=>{
  view();fireEvent.click(screen.getByRole("button",{name:"Delete organization"}));
  expect(screen.getByRole("button",{name:"Permanently delete organization"}).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"fixture production"}});
  expect(screen.getByRole("button",{name:"Permanently delete organization"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(rpc.clear).not.toHaveBeenCalled();
});
it("keeps exact recovery intent after the section closes, with account and org isolation",async()=>{
  const client=cache();rpc.clear.mockRejectedValueOnce(new Error("Reply lost"));
  const first=view(client);confirm();await settle();
  const original=rpc.clear.mock.calls[0][0].data;
  first.unmount();const other=view(client,"other");expect(screen.queryByRole("button",{name:"Retry organization deletion"})).toBeNull();other.unmount();
  const foreign=view(client,"user","other-org");expect(screen.queryByRole("button",{name:"Retry organization deletion"})).toBeNull();foreign.unmount();
  view(client);rpc.clear.mockResolvedValueOnce(response());
  fireEvent.click(screen.getByRole("button",{name:"Retry organization deletion"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data).toEqual(original);expect(screen.getByRole("status").textContent).toContain("Organization deletion confirmed.");
});
it("bounds unconfirmed clears and ignores their late reply after retry",async()=>{
  let release=(_:unknown)=>{};rpc.clear.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  view();confirm();await settle(20_100);
  expect(rpc.navigate).not.toHaveBeenCalled();
  expect(rpc.clear.mock.calls[0][0].signal.aborted).toBe(true);
  rpc.clear.mockResolvedValueOnce(response());fireEvent.click(screen.getByRole("button",{name:"Retry organization deletion"}));await settle();
  release(response());await settle();expect(rpc.navigate).toHaveBeenCalledTimes(1);expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByRole("status").textContent).toContain("Organization deletion confirmed.");
});

it("bounds navigation after confirmed deletion and retries without repeating confirmation",async()=>{
  rpc.clear.mockResolvedValue({alreadyDeleted:false});rpc.navigate.mockImplementationOnce(()=>new Promise(()=>{}));
  view();confirm();await settle(5_100);
  expect(screen.getByRole("alert").textContent).toContain("navigation did not finish");
  rpc.clear.mockResolvedValueOnce({alreadyDeleted:true});
  fireEvent.click(screen.getByRole("button",{name:"Retry organization deletion"}));await settle();
  expect(rpc.clear.mock.calls[1][0].data).toEqual(rpc.clear.mock.calls[0][0].data);
  expect(rpc.navigate).toHaveBeenCalledTimes(2);
});
