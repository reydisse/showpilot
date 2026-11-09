import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadChatHook } from "../../test/native-chat-hook.js";

afterEach(cleanup);
it.each([true,false])("drops a late native history page after a clear, including reconnect hydration (live=%s)",async live=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const socket={readyState:1,send:vi.fn(),close:vi.fn(),onopen:null,onmessage:null,onclose:null,onerror:null};
  const query = new QueryClient();
  vi.spyOn(query, "invalidateQueries");
  const useChatRelay = loadChatHook({createAuthenticatedWebSocket:async()=>socket,getNativeCookieHeader:async()=>({}),getAuthenticatedFetchCredentials:()=>"include"},
    {currentState:"active",addEventListener:()=>({remove(){}})},vi.fn(()=>pending));
  const message=(id,timestamp)=>({id,timestamp,senderName:"Member",text:id,type:"text"});
  const wrapper = ({children}) => React.createElement(QueryClientProvider, {client:query}, children);
  const {result}=renderHook(()=>useChatRelay("org","production","member"), {wrapper});
  await act(async()=>{await Promise.resolve();});
  await act(async()=>{socket.onopen?.();socket.onmessage?.({data:JSON.stringify({type:"hydrate",messages:Array.from({length:2000},(_,i)=>message(`old-${i}`,i+1))})});});
  let loading;
  act(()=>{loading=result.current.loadOlder();});
  await act(async()=>{await Promise.resolve();});
  act(()=>{socket.onmessage({data:JSON.stringify({type:"hydrate",historyCleared:live,historyClearVersion:1,messages:[message("after-clear",3000)],readReceipts:{}})});});
  await act(async()=>{release(Response.json({messages:[message("stale",0)],nextCursor:null}));await loading;});
  expect(result.current.messages.map(m=>m.id)).toEqual(["after-clear"]);expect(result.current.loadingOlder).toBe(false);expect(result.current.lastError).toBeNull();
  act(()=>{socket.onmessage({data:JSON.stringify({type:"message",message:message("latest",3001)})});});
  expect(result.current.messages.map(m=>m.id)).toEqual(["after-clear","latest"]);expect(query.invalidateQueries).toHaveBeenCalled();
});
