import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as history from "../../../../mobile/src/lib/chat-history.ts";

// Execute the actual native hook with native transport/AppState at their test boundaries.
// Transpile only: keep all hook, generation and message parsing logic unchanged.
const source=readFileSync(resolve(process.cwd(),"../mobile/src/hooks/use-chat-relay.ts"),"utf8");
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
afterEach(cleanup);
it.each([true,false])("drops a late native history page after a clear, including reconnect hydration (live=%s)",async live=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const socket={readyState:1,send:vi.fn(),close:vi.fn(),onopen:null,onmessage:null,onclose:null,onerror:null};
  const query={invalidateQueries:vi.fn()};
  const modules={
    react:React,"@tanstack/react-query":{useQueryClient:()=>query},"expo/fetch":{fetch:vi.fn(()=>pending)},
    "react-native":{AppState:{currentState:"active",addEventListener:()=>({remove(){}})}},
    "@/lib/auth-transport":{createAuthenticatedWebSocket:async()=>socket,getNativeCookieHeader:async()=>({}),getAuthenticatedFetchCredentials:()=>"include"},
    "@/lib/chat-history":history,"@/lib/env":{SHOWPILOT_URL:"https://fixture.invalid"},
  };
  const exports={};new Function("require","exports",code)(name=>{if(!(name in modules))throw new Error(`Unmocked native import ${name}`);return modules[name];},exports);
  const message=(id,timestamp)=>({id,timestamp,senderName:"Member",text:id,type:"text"});
  const {result}=renderHook(()=>exports.useChatRelay("org","production"));
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
